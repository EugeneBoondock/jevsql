import './quiet.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { integer, stableJson } from './validation.mjs';
import { digest, jsonData, redactText } from './privacy.mjs';

/** Local receipts and append-only human labels. No database credentials go to Jev. */
export class ReceiptStore {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _jevsql_receipts (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        previous_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _jevsql_feedback (
        id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, revision INTEGER NOT NULL,
        reviewer TEXT NOT NULL, label TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(receipt_id, revision)
      );
      CREATE TABLE IF NOT EXISTS _jevsql_chain (
        sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        payload TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
        UNIQUE(kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS _jevsql_receipt_queue ON _jevsql_receipts(decision, sequence);
    `);
    // A store written before the chain existed keeps its receipt hashes: they use
    // the same formula, so an archived head hash stays valid after the backfill.
    if (!this.db.prepare('SELECT 1 FROM _jevsql_chain LIMIT 1').get()) {
      const insert = this.db.prepare('INSERT INTO _jevsql_chain(kind,ref_id,payload,previous_hash,hash) VALUES (?,?,?,?,?)');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare('SELECT * FROM _jevsql_receipts ORDER BY sequence').all()) {
          insert.run('receipt', row.id, row.payload, row.previous_hash, row.hash);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  /** Append one entry to the single integrity log. Callers hold the transaction. */
  #chain(kind, refId, payload) {
    const previous = this.db.prepare('SELECT hash FROM _jevsql_chain ORDER BY sequence DESC LIMIT 1').get()?.hash ?? '';
    const hash = digest([previous, payload]);
    this.db.prepare('INSERT INTO _jevsql_chain(kind,ref_id,payload,previous_hash,hash) VALUES (?,?,?,?,?)')
      .run(kind, refId, payload, previous, hash);
    return { previous, hash };
  }

  append(receipt) {
    const payload = stableJson(jsonData(receipt));
    if (!receipt.id || !['eligible', 'review', 'block'].includes(receipt.decision) || !Number.isFinite(Date.parse(receipt.createdAt))) {
      throw new TypeError('A receipt needs an id, decision, and creation timestamp.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT payload FROM _jevsql_receipts WHERE id=?').get(receipt.id);
      if (existing) {
        if (existing.payload !== payload) throw new Error('Receipt id already refers to different evidence.');
      } else {
        const { previous, hash } = this.#chain('receipt', receipt.id, payload);
        this.db.prepare('INSERT INTO _jevsql_receipts(id,decision,created_at,payload,previous_hash,hash) VALUES (?,?,?,?,?,?)')
          .run(receipt.id, receipt.decision, receipt.createdAt, payload, previous, hash);
      }
      this.db.exec('COMMIT');
      return receipt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(id) {
    const row = this.db.prepare('SELECT payload FROM _jevsql_receipts WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  list({ decision, limit = 100 } = {}) {
    integer(limit, 'limit', 1, 10000);
    const rows = decision == null
      ? this.db.prepare('SELECT payload FROM _jevsql_receipts ORDER BY sequence DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT payload FROM _jevsql_receipts WHERE decision=? ORDER BY sequence DESC LIMIT ?').all(decision, limit);
    return rows.map((row) => JSON.parse(row.payload));
  }

  queue({ limit = 100 } = {}) {
    integer(limit, 'limit', 1, 10000);
    return this.db.prepare(`SELECT r.payload FROM _jevsql_receipts r
      WHERE r.decision='review' AND NOT EXISTS(SELECT 1 FROM _jevsql_feedback f WHERE f.receipt_id=r.id)
      ORDER BY r.sequence LIMIT ?`).all(limit).map((row) => JSON.parse(row.payload));
  }

  feedback(receiptId, { reviewer, label, reason = '', expectedRevision = 0 }) {
    if (!this.get(receiptId)) throw new Error('Unknown receipt.');
    if (typeof reviewer !== 'string' || !reviewer.trim() || !['string', 'number', 'boolean'].includes(typeof label)) {
      throw new TypeError('Feedback needs a reviewer and scalar ground-truth label.');
    }
    jsonData(label); integer(expectedRevision, 'expectedRevision', 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM _jevsql_feedback WHERE receipt_id=?').get(receiptId).n;
      if (revision !== expectedRevision) throw new Error('Feedback changed. Read its latest revision before replacing a label.');
      const result = { id: randomUUID(), receiptId, revision: revision + 1, reviewer: redactText(reviewer), label,
        reason: redactText(reason), createdAt: new Date().toISOString() };
      // A human label decides what a receipt meant, so it belongs in the same
      // integrity log; otherwise a later edit to it leaves verify() reporting ok.
      this.#chain('feedback', result.id, stableJson(result));
      this.db.prepare('INSERT INTO _jevsql_feedback VALUES (?,?,?,?,?,?,?)')
        .run(result.id, receiptId, result.revision, result.reviewer, JSON.stringify(label), result.reason, result.createdAt);
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  labels(receiptId) {
    return this.db.prepare('SELECT * FROM _jevsql_feedback WHERE receipt_id=? ORDER BY revision').all(receiptId)
      .map((row) => ({ id: row.id, receiptId: row.receipt_id, revision: row.revision, reviewer: row.reviewer,
        label: JSON.parse(row.label), reason: row.reason, createdAt: row.created_at }));
  }

  /** Detect local edits, deletions and insertions across receipts and human
   * labels; archive the returned head hash elsewhere to anchor it. */
  verify() {
    let previous = '', count = 0, feedbackCount = 0;
    const seen = { receipt: new Set(), feedback: new Set() };
    for (const row of this.db.prepare('SELECT * FROM _jevsql_chain ORDER BY sequence').iterate()) {
      if (row.previous_hash !== previous || digest([previous, row.payload]) !== row.hash) return { ok: false, sequence: row.sequence };
      if (row.kind === 'receipt') {
        const stored = this.db.prepare('SELECT * FROM _jevsql_receipts WHERE id=?').get(row.ref_id);
        const receipt = JSON.parse(row.payload);
        if (!stored || stored.payload !== row.payload || receipt.id !== row.ref_id
          || stored.decision !== receipt.decision || stored.created_at !== receipt.createdAt) return { ok: false, sequence: row.sequence };
        count++;
      } else if (row.kind === 'feedback') {
        const stored = this.db.prepare('SELECT * FROM _jevsql_feedback WHERE id=?').get(row.ref_id);
        if (!stored || stableJson({ id: stored.id, receiptId: stored.receipt_id, revision: stored.revision,
          reviewer: stored.reviewer, label: JSON.parse(stored.label), reason: stored.reason,
          createdAt: stored.created_at }) !== row.payload) return { ok: false, sequence: row.sequence };
        feedbackCount++;
      } else return { ok: false, sequence: row.sequence };
      seen[row.kind].add(row.ref_id);
      previous = row.hash;
    }
    // Rows appended straight to a table, bypassing the log, are also tampering.
    for (const [kind, table] of [['receipt', '_jevsql_receipts'], ['feedback', '_jevsql_feedback']]) {
      for (const row of this.db.prepare(`SELECT id FROM ${table}`).iterate()) {
        if (!seen[kind].has(row.id)) return { ok: false, sequence: null, unlogged: { kind, id: row.id } };
      }
    }
    return { ok: true, count, feedbackCount, entries: count + feedbackCount, head: previous };
  }

  close() { this.db.close(); }
}
