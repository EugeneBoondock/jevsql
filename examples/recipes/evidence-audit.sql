-- One judgment supplies the decision, confidence, and full distribution.
SELECT id, claim, expected,
  jev_choice(
    json_object('claim', claim, 'evidence', evidence),
    'What is the relationship between the claim and the supplied evidence?',
    '{"supported":"The evidence directly supports the whole claim.","contradicted":"The evidence directly conflicts with the claim.","unknown":"The evidence does not settle the claim."}'
  ) AS prediction,
  jev_choice_conf(
    json_object('claim', claim, 'evidence', evidence),
    'What is the relationship between the claim and the supplied evidence?',
    '{"supported":"The evidence directly supports the whole claim.","contradicted":"The evidence directly conflicts with the claim.","unknown":"The evidence does not settle the claim."}'
  ) AS confidence,
  jev_choice_probs(
    json_object('claim', claim, 'evidence', evidence),
    'What is the relationship between the claim and the supplied evidence?',
    '{"supported":"The evidence directly supports the whole claim.","contradicted":"The evidence directly conflicts with the claim.","unknown":"The evidence does not settle the claim."}'
  ) AS probabilities
FROM claims
ORDER BY id;
