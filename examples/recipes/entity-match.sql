-- Block candidate pairs with cheap SQL before asking about their meaning.
-- A high score is a candidate for review, never an instruction to merge records.
SELECT a.id || ':' || b.id AS id, a.name AS incoming, b.name AS existing,
  jev_match(
    json_object('name', a.name, 'city', a.city, 'country', a.country),
    json_object('name', b.name, 'city', b.city, 'country', b.country),
    'Do these records describe the same business, allowing legal suffixes and abbreviations?'
  ) AS match_probability
FROM incoming_companies a
JOIN companies b ON a.country = b.country AND a.city = b.city
ORDER BY match_probability DESC, id;
