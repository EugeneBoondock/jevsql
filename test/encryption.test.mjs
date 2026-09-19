import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createAesGcmDecryptor, createEncryptedRowDecoder } from '../src/encryption.mjs';

test('authenticated decrypt supports rotation and refuses wrong keys, AAD and tampering', () => {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('tenant-a'));
  const ciphertext = Buffer.concat([cipher.update('12.34'), cipher.final()]).toString('hex');
  const envelope = { algorithm: 'aes-256-gcm', version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext };
  const decrypt = createAesGcmDecryptor({ keys: [randomBytes(32), key.toString('hex')], aad: 'tenant-a' });
  assert.equal(decrypt(envelope), '12.34');
  for (const options of [{ keys: [randomBytes(32)], aad: 'tenant-a' }, { keys: [key], aad: 'tenant-b' }]) {
    assert.throws(() => createAesGcmDecryptor(options)(envelope), /Authenticated decryption failed/);
  }
  for (const patch of [{ tag: '00'.repeat(16) }, { ciphertext: '00' }, { version: 2 }, { algorithm: 'unknown' }, { iv: 'bad' }]) assert.throws(() => decrypt({ ...envelope, ...patch }));
  assert.throws(() => createAesGcmDecryptor({ keys: ['bad'], aad: '' }));
  assert.throws(() => createAesGcmDecryptor());
});

test('selective async decoding preserves inputs and never decrypts unrelated fields', async () => {
  const row = { amount: '[ENCRYPTED]', properties: JSON.stringify({ amount: '[ENCRYPTED]' }), enc_data: { amount: { ciphertext: 'selected' }, email: { ciphertext: 'private' } } };
  const original = structuredClone(row), seen = [];
  const decode = createEncryptedRowDecoder({ fields: ['amount'], decrypt: async (value, context) => { seen.push(context.field); return '12.34'; } });
  const [out] = await decode([row]);
  assert.equal(out.amount, '12.34'); assert.equal(out.properties.amount, '12.34');
  assert.deepEqual(row, original); assert.deepEqual(seen, ['amount']);
  const json = createEncryptedRowDecoder({ fields: ['amount'], jsonFields: ['amount'], decrypt: () => '12' });
  assert.equal((await json([row]))[0].properties.amount, 12);
  const legacy = createEncryptedRowDecoder({ fields: ['amount'] });
  assert.equal((await legacy([{ enc_data: { amount: { encrypted: false, plaintext: '7' } } }]))[0].properties.amount, '7');
});

test('bad structures, missing decryptors and unreadable results fail closed', async () => {
  const row = { properties: { amount: { encrypted: true } } };
  for (const decrypt of [undefined, () => undefined, x => x, () => '[ENCRYPTED]', () => { throw new Error('private key'); }]) {
    await assert.rejects(createEncryptedRowDecoder({ fields: ['amount'], decrypt })([row]), { message: 'Required field decryption failed' });
  }
  const decode = createEncryptedRowDecoder({ fields: ['amount'] });
  for (const rows of [null, [null], [{ properties: '[]' }]]) await assert.rejects(decode(rows));
  for (const fields of [[], ['__proto__'], ['constructor'], ['a.b']]) assert.throws(() => createEncryptedRowDecoder({ fields }));
});
