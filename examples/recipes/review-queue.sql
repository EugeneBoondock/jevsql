-- This reads a saved table: no model calls, usable in any SQLite client.
SELECT id, claim, prediction, confidence,
  CASE
    WHEN confidence < 0.8 THEN 'review uncertain evidence'
    WHEN prediction = 'contradicted' THEN 'repair stale claim'
    WHEN prediction = 'unknown' THEN 'collect missing evidence'
    ELSE 'ready'
  END AS next_action
FROM evidence_decisions
WHERE confidence < 0.8 OR prediction <> 'supported'
ORDER BY confidence ASC, id;
