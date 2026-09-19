import { createDecipheriv } from 'node:crypto';

const encrypted = value => value && typeof value === 'object'
  && (Object.hasOwn(value, 'ciphertext') || value.encrypted === true);
const object = value => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value ?? {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid encrypted row structure');
  return parsed;
};
const safeName = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  && !['__proto__', 'prototype', 'constructor'].includes(name);

/** Decode only requested fields. Keys and tenant authorization stay with the host.
 * Supports separate encrypted maps, nested wrappers and inline envelopes.
 * A synchronous local vault or asynchronous KMS callback may provide decryption.
 */
export function createEncryptedRowDecoder({ fields, decrypt, propertiesKey = 'properties',
  encryptedKey = 'enc_data', wrapperKey = '__encrypted', jsonFields = [] } = {}) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 256
    || ![...fields, propertiesKey, encryptedKey, wrapperKey].every(safeName)
    || !Array.isArray(jsonFields) || jsonFields.some(name => !fields.includes(name))) {
    throw new TypeError('Explicit safe field names are required');
  }
  return async rows => {
    if (!Array.isArray(rows)) throw new TypeError('Rows must be an array');
    const output = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid row');
      const properties = { ...object(row[propertiesKey]) };
      const envelopes = { ...object(properties[wrapperKey]), ...object(row[encryptedKey]) };
      const copy = { ...row, [propertiesKey]: properties };
      for (const name of fields) {
        const mapped = Object.hasOwn(envelopes, name);
        const value = mapped ? envelopes[name] : Object.hasOwn(properties, name) ? properties[name] : row[name];
        if (!mapped && !encrypted(value)) continue;
        let decoded;
        try {
          if (value?.encrypted === false && Object.hasOwn(value, 'plaintext') && !Object.hasOwn(value, 'ciphertext')) decoded = value.plaintext;
          else {
            if (typeof decrypt !== 'function') throw new Error('No decryptor');
            decoded = await decrypt(value, { field: name });
          }
          if (decoded === undefined || encrypted(decoded) || decoded === '[ENCRYPTED]') throw new Error('Unreadable value');
          if (jsonFields.includes(name) && typeof decoded === 'string') decoded = JSON.parse(decoded);
        } catch { throw new Error('Required field decryption failed'); }
        properties[name] = decoded;
        if (Object.hasOwn(row, name)) copy[name] = decoded;
      }
      output.push(copy);
    }
    return output;
  };
}

/** Authenticated AES-256-GCM for hex envelopes, with explicit AAD and rotated keys.
 * Never reads keys from row content or process environment.
 */
export function createAesGcmDecryptor({ keys, aad } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 4 || typeof aad !== 'string') throw new TypeError('Explicit keys and AAD required');
  const buffers = keys.map(key => {
    if (Buffer.isBuffer(key) && key.length === 32) return Buffer.from(key);
    if (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)) return Buffer.from(key, 'hex');
    throw new TypeError('AES keys must be 32 bytes');
  });
  const hex = (value, bytes) => typeof value === 'string' && /^(?:[a-f0-9]{2})*$/i.test(value)
    && (bytes == null || value.length === bytes * 2);
  return envelope => {
    if (!envelope || envelope.algorithm !== 'aes-256-gcm' || envelope.version !== 1
      || ![12, 16].some(bytes => hex(envelope.iv, bytes)) || !hex(envelope.tag, 16)
      || !hex(envelope.ciphertext) || envelope.ciphertext.length > 2000000) throw new Error('Invalid AES-GCM envelope');
    for (const key of buffers) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8');
      } catch { /* Try the next explicitly supplied rotation key. */ }
    }
    throw new Error('Authenticated decryption failed');
  };
}
