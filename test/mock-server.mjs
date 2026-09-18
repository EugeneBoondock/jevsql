// A stand-in for the TypeSafe API so the test suite needs no key and no network.
// It answers with deterministic, keyword-driven judgments and counts requests.
import http from 'node:http';

export async function startMockServer({ latencyMs = 0 } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');

    if (!req.headers.authorization?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'missing key' }));
    }
    calls.push(body);
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));

    const answers = {};
    let inputTokens = JSON.stringify(body.state).length / 4;
    for (const [id, q] of Object.entries(body.questions ?? {})) {
      const path = String(q.instructions?.subject ?? '').replace(/`/g, '').split('.').pop();
      const text = String(body.state?.rows?.[path] ?? '').toLowerCase();
      const question = String(q.instructions?.question ?? '').toLowerCase();
      inputTokens += (question.length + 40) / 4;

      if (q.type === 'noul') {
        // "angry" style questions key off the text; everything else is a mild no.
        const hit = /angry|furious|frustrat|refund|urgent|asap|broken|down/.test(text)
          && /angry|frustrat|refund|urgent|unhappy|upset|problem/.test(question);
        answers[id] = { type: 'noul', noul: hit ? 0.93 : 0.07 };
      } else if (q.type === 'choice') {
        const options = Object.keys(q.criteria);
        const picked = options.find((o) => text.includes(o.toLowerCase())) ?? options[0];
        const probabilities = Object.fromEntries(options.map((o) => [o, o === picked ? 0.8 : 0.2 / (options.length - 1 || 1)]));
        answers[id] = { type: 'choice', choice: picked, probabilities, confidence: text.includes('ambiguous') ? 0.3 : 0.86 };
      } else {
        const levels = q.criteria;
        const top = /emergency|down|asap|urgent/.test(text) ? levels.length - 1 : /soon|slow/.test(text) ? 1 : 0;
        const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === top ? 0.85 : 0.15 / (levels.length - 1 || 1)]));
        answers[id] = {
          type: 'score',
          score: top * 0.85 + (top > 0 ? (top - 1) * 0.05 : 0),
          legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
          probabilities,
          confidence: 0.8,
        };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-mock-1.0',
      answers,
      usage: { input_tokens: Math.ceil(inputTokens), output_tokens: Object.keys(answers).length * 8 },
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    get requestCount() { return calls.length; },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}
