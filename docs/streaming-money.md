# Large monetary totals without large responses

Use `jevsql/money` for deterministic sums over data too large to return in one
response. It makes no Jev API calls. The decision layer can select this operation;
money arithmetic stays in code.

```js
import { aggregatePgMoney } from 'jevsql/money';

const result = await aggregatePgMoney({
  pool,
  sql: 'SELECT amount, currency FROM deals WHERE portal_id = $1',
  values: [authorizedPortalId],
  pageSize: 1000,
  amount: row => row.amount,
  currency: row => row.currency,
  signal: AbortSignal.timeout(45000)
});
```

The caller supplies trusted SQL and enforces tenant access. The adapter opens
a read-only repeatable-read transaction, fetches through a cursor, and releases
the connection after rollback. It does not create tables, indexes, or functions.
PostgreSQL numeric values should arrive as decimal strings, not converted floats.

For encrypted fields, provide `decode: rows => decryptBatch(rows)` and an optional
`include: row => matchesFilters(row)`. Decryption must throw on failure. Do not
return placeholder amounts or silently drop unreadable rows.

`jevsql/encryption` exports `createEncryptedRowDecoder({ fields, decrypt })`.
It reads separate `enc_data` maps, `properties.__encrypted` maps, and inline
envelopes. Only explicitly listed fields are decoded, using the host vault or
an async key service. Pass the returned function as `decode` above. Morphed uses
its existing DataVault, keeping keys on the backend. Unrelated fields remain
unchanged, so always project an explicit field list before sending data to Jev.

For compatible hex envelopes, `createAesGcmDecryptor({ keys, aad })` supports
authenticated AES-256-GCM version 1 and up to four rotation keys. Keys must be
32-byte buffers or 64-character hex strings. AAD must match the encrypting host.
Wrong keys, changed ciphertext, unsupported versions, and failed authentication
throw. This does not decrypt arbitrary database formats or bypass authorization.
Never send keys to the model or use database row content to choose trusted keys.

`totals` contains one entry per currency. Exact sums are strings. Currency is
null when unknown. Missing or malformed amounts produce a null group `total`
and separate counters; `knownAmountTotal` is explicitly only the readable subtotal.
`moneyComplete` is false if amounts or currencies are missing or invalid.
Currencies are never converted or added together. Scientific notation, formatted
currency strings, and unsafe numeric values are refused as invalid amounts.

Page errors, stalled cursors, cancellation, and exhausted budgets throw without
returning partial totals. Defaults bound pages, rows, and currency buckets.
The total covers the authorized SQL result at the transaction snapshot, not
records absent from the source database.

Other readers can use `aggregateMoney` with a bounded `readPage` callback that
returns `{ rows, done, nextCursor }`. A short page is not treated as exhaustion
unless the reader explicitly sets `done: true`.

Verify against a large, generated PostgreSQL dataset with no stored data changes:

```sh
node --env-file=.env.local examples/large-money-total.mjs --live
```
