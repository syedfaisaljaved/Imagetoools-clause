import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgt-'));
const app = 'http://127.0.0.1:18080', agent = 'http://127.0.0.1:18081';
let srv, cookie;
const call = (base, p, body, method = body ? 'POST' : 'GET') =>
  fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

before(() => (srv = startServer({ port: 18080, agentPort: 18081, dataDir: dir, password: 'pw' })));
after(() => srv.close());

test('login protects the app', async () => {
  assert.equal((await call(app, '/api/state')).status, 401);
  assert.match(await (await call(app, '/')).text(), /password/i); // login page
  assert.equal((await call(app, '/login', { password: 'nope' })).status, 401);
  const r = await call(app, '/login', { password: 'pw' });
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(app, '/api/state')).status, 200);
});

test('full job lifecycle: create → agent claims → output → done → file served', async () => {
  const job = await (await call(app, '/api/jobs', { tool: 'angles', images: { product: `data:image/png;base64,${PNG}` }, options: { angles: ['Front', 'Back'] } })).json();
  assert.equal(job.status, 'queued');
  assert.equal(job.total, 2);

  const { job: work } = await (await call(agent, '/agent/next')).json();
  assert.equal(work.id, job.id);
  assert.equal(work.steps[0].images[0].data, PNG);
  assert.equal((await (await call(agent, '/agent/next')).json()).job, null); // running job got interrupted, queue empty

  // simulate interruption semantics, then a clean run via retry
  let state = await (await call(app, '/api/state')).json();
  assert.equal(state.jobs[0].status, 'failed');
  await call(app, `/api/jobs/${job.id}/retry`, {});
  await call(agent, '/agent/next');
  await call(agent, `/agent/jobs/${job.id}/output`, { step: 0, image: PNG });
  await call(agent, `/agent/jobs/${job.id}/output`, { step: 1, error: 'refused' });
  await call(agent, `/agent/jobs/${job.id}/finish`, {});

  state = await (await call(app, '/api/state')).json();
  const done = state.jobs[0];
  assert.equal(done.status, 'done');
  assert.equal(state.agent.state, 'busy');
  const img = await call(app, `/files/${job.id}/${done.outputs[0].file}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG);

  assert.equal((await call(app, `/api/jobs/${job.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await (await call(app, '/api/state')).json()).jobs.length, 0);
});

test('rejects bad input', async () => {
  const r = await call(app, '/api/jobs', { tool: 'angles', images: { product: 'data:text/plain;base64,AA' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /PNG, JPG or WEBP/);
});
