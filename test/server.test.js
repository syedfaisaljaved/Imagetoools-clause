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
  assert.equal(state.agents.chatgpt.state, 'busy');
  const img = await call(app, `/files/${job.id}/${done.outputs[0].file}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG);

  assert.equal((await call(app, `/api/jobs/${job.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await (await call(app, '/api/state')).json()).jobs.length, 0);
});

test('drawing job runs on Claude first, then ChatGPT gets the Claude prompt + all photos', async () => {
  const job = await (await call(app, '/api/jobs', { tool: 'drawing', images: { photos: [`data:image/png;base64,${PNG}`, `data:image/png;base64,${PNG}`] } })).json();
  assert.equal((await (await call(agent, '/agent/next?site=chatgpt&agent=g')).json()).job, null); // not ChatGPT's turn yet

  const { job: c } = await (await call(agent, '/agent/next?site=claude&agent=c')).json();
  assert.equal(c.steps.length, 1);
  assert.equal(c.steps[0].images.length, 2);
  await call(agent, `/agent/jobs/${job.id}/output?site=claude`, { step: 0, text: 'Line drawing of a sofa' });
  await call(agent, `/agent/jobs/${job.id}/finish?site=claude`, {});

  const { job: g } = await (await call(agent, '/agent/next?site=chatgpt&agent=g')).json();
  assert.equal(g.steps[0].index, 1);
  assert.match(g.steps[0].prompt, /^Line drawing of a sofa\n/);
  assert.equal(g.steps[0].images.length, 2);
  await call(agent, `/agent/jobs/${job.id}/output`, { step: 1, image: PNG });
  await call(agent, `/agent/jobs/${job.id}/finish`, {});
  const state = await (await call(app, '/api/state')).json();
  assert.equal(state.jobs.find((j) => j.id === job.id).status, 'done');
});

test('drawing per part alternates Claude and ChatGPT, each ChatGPT step gets its own Claude prompt', async () => {
  const job = await (await call(app, '/api/jobs', { tool: 'specs', images: { photos: [`data:image/png;base64,${PNG}`] }, options: { parts: 'headboard, footboard' } })).json();
  for (const [i, part] of ['headboard', 'footboard'].entries()) {
    const { job: c } = await (await call(agent, '/agent/next?site=claude&agent=c')).json();
    assert.equal(c.steps[0].index, i * 2);
    await call(agent, `/agent/jobs/${job.id}/output?site=claude`, { step: i * 2, text: `Draw the ${part}` });
    await call(agent, `/agent/jobs/${job.id}/finish?site=claude`, {});
    const { job: g } = await (await call(agent, '/agent/next?site=chatgpt&agent=g')).json();
    assert.match(g.steps[0].prompt, new RegExp(`^Draw the ${part}\\n`));
    await call(agent, `/agent/jobs/${job.id}/output`, { step: i * 2 + 1, image: PNG });
    await call(agent, `/agent/jobs/${job.id}/finish`, {});
  }
  assert.equal(srv.store.get(job.id).status, 'done');
});

test('Claude failure fails the whole job; a second tab polling does not interrupt a running job', async () => {
  const job = await (await call(app, '/api/jobs', { tool: 'outline', images: { photos: [`data:image/png;base64,${PNG}`] } })).json();
  await call(agent, '/agent/next?site=claude&agent=c1');
  await call(agent, '/agent/next?site=claude&agent=c2'); // other tab: must not interrupt c1's job
  assert.equal(srv.store.get(job.id).status, 'running');
  await call(agent, `/agent/jobs/${job.id}/output?site=claude`, { step: 0, error: 'Claude gave no reply' });
  await call(agent, `/agent/jobs/${job.id}/finish?site=claude`, { error: 'Claude gave no reply' });
  assert.equal(srv.store.get(job.id).status, 'failed');
});

test('"show window" request is delivered once, only to that site', async () => {
  await call(app, '/api/front', { site: 'claude' });
  assert.equal((await (await call(agent, '/agent/next?site=chatgpt&agent=g')).json()).front, false);
  assert.equal((await (await call(agent, '/agent/status?site=claude', { state: 'login' })).json()).front, true);
  assert.equal((await (await call(agent, '/agent/next?site=claude&agent=c')).json()).front, false);
});

test('factory photo is copied into the job and sent to the agent', async () => {
  const job = await (await call(app, '/api/jobs', { tool: 'wood', images: { product: `data:image/png;base64,${PNG}` } })).json();
  assert.equal(job.inputs.factory, 'in-factory.jpg');
  const { job: w } = await (await call(agent, '/agent/next?site=chatgpt&agent=f')).json();
  assert.equal(w.id, job.id);
  assert.deepEqual(w.steps[0].images.map((i) => [i.name, i.type]), [[`${job.id}-in-product.png`, 'image/png'], [`${job.id}-in-factory.jpg`, 'image/jpeg']]);
  assert.ok(w.steps[0].images[1].data.length > 100000);
  await call(agent, `/agent/jobs/${job.id}/finish`, { error: 'test done' });
});

test('rejects bad input', async () => {
  const r = await call(app, '/api/jobs', { tool: 'angles', images: { product: 'data:text/plain;base64,AA' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /PNG, JPG or WEBP/);
});

test('generate job without photos sends the prompt alone', async () => {
  const job = await (await call(app, '/api/jobs', { tool: 'generate', images: { photos: [] }, options: { prompt: 'A sofa on the moon' } })).json();
  const { job: g } = await (await call(agent, '/agent/next?site=chatgpt&agent=x')).json();
  assert.equal(g.id, job.id);
  assert.deepEqual(g.steps[0].images, []);
  assert.match(g.steps[0].prompt, /^A sofa on the moon/);
  await call(agent, `/agent/jobs/${job.id}/finish`, { error: 'test done' });
});
