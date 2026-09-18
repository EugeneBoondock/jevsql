-- Regex finds exact source spans. Jev selects a span; code copies its bytes.
-- NULL means no candidate or insufficient confidence, so it enters a review queue.
SELECT id,
  jev_candidates(notes, 'email') AS candidates,
  jev_pick(notes, 'Which email should receive future invoices?',
    jev_candidates(notes, 'email'), 0.8) AS invoice_email,
  jev_pick_conf(notes, 'Which email should receive future invoices?',
    jev_candidates(notes, 'email')) AS confidence
FROM contact_notes
ORDER BY id;
