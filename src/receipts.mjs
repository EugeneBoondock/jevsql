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
      CREATE INDEX IF NOT EXISTS _jevsql_receipt_queue ON _jevsql_receipts(decision, sequence);
    `);
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
        const previous = this.db.prepare('SELECT hash FROM _jevsql_receipts ORDER BY sequence DESC LIMIT 1').get()?.hash ?? '';
        this.db.prepare('INSERT INTO _jevsql_receipts(id,decision,created_at,payload,previous_hash,hash) VALUES (?,?,?,?,?,?)')
          .run(receipt.id, receipt.decision, receipt.createdAt, payload, previous, digest([previous, payload]));
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

  /** Detect local edits/deletions; archive the returned head hash elsewhere to anchor it. */
  verify() {
    let previous = '', count = 0;
    for (const row of this.db.prepare('SELECT * FROM _jevsql_receipts ORDER BY sequence').iterate()) {
      if (row.previous_hash !== previous || digest([previous, row.payload]) !== row.hash) return { ok: false, sequence: row.sequence };
      const receipt = JSON.parse(row.payload);
      if (receipt.id !== row.id || receipt.decision !== row.decision || receipt.createdAt !== row.created_at) return { ok: false, sequence: row.sequence };
      previous = row.hash; count++;
    }
    return { ok: true, count, head: previous };
  }

  close() { this.db.close(); }
}
