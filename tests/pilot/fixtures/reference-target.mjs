// PROD-03 clean-room drill — the reference governed-action TARGET, a separate
// process standing in for the pilot's own system (a deployment service).
//
// TEST ONLY. It is the "target system" of the shared-responsibility model: it
// receives what the Host's adapter sends and records each effect it performed,
// keyed by the Frontera execution id. The drill counts effects HERE, in another
// process, so "exactly one effect" is what the target saw — not what the Host
// believes. It holds no Frontera credential and can reach nothing.
//
//   POST /effects   {executionId, requestId, action, resource, parameters}  -> 200 {effectId}
//   GET  /effects   -> {effects: [...]}
//   POST /mode      {mode: 'normal' | 'reject' | 'accept-then-hang'}  (drill control)
//
// mode `accept-then-hang` performs the effect and never answers: the Host's
// adapter times out and reports `unconfirmed` — the case where an operator must
// establish the outcome here, never by resending.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// The effect log survives a target restart (the target-outage drill): what the
// target performed is the target's record, not the Host's.
const LOG = process.env.FRONTERA_DRILL_TARGET_LOG;
const effects = LOG !== undefined && existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
let mode = 'normal';
let sequence = effects.length;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65536) rejectBody(new Error('too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/effects') return json(res, 200, { effects });
    if (req.method === 'POST' && req.url === '/mode') {
      const body = JSON.parse(await readBody(req));
      if (!['normal', 'reject', 'accept-then-hang'].includes(body.mode)) return json(res, 400, { error: 'mode' });
      mode = body.mode;
      return json(res, 200, { mode });
    }
    if (req.method === 'POST' && req.url === '/effects') {
      const body = JSON.parse(await readBody(req));
      if (mode === 'reject') return json(res, 409, { error: 'rejected by the target' });
      sequence = effects.length + 1;
      const effect = { effectId: `effect-${sequence}`, executionId: body.executionId, requestId: body.requestId, action: body.action, resource: body.resource, parameters: body.parameters ?? null, at: new Date().toISOString() };
      effects.push(effect);
      if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify(effect)}\n`);
      if (mode === 'accept-then-hang') return; // performed; never answered
      return json(res, 200, { effectId: effect.effectId });
    }
    return json(res, 404, { error: 'not found' });
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
});

server.listen(Number(process.env.FRONTERA_DRILL_TARGET_PORT ?? '0'), '127.0.0.1', () => {
  console.log(`reference-target listening ${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
