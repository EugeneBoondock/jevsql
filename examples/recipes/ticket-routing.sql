SELECT id, customer,
  jev_choice(body, 'Which team should handle this ticket?',
    'billing,technical,sales,cancellation', 0.8) AS team,
  jev_choice_conf(body, 'Which team should handle this ticket?',
    'billing,technical,sales,cancellation') AS confidence,
  jev_decide(body, 'Is this customer at risk of leaving?', 0.1, 0.9) AS churn_risk
FROM tickets
WHERE status = 'open'
ORDER BY id;
