// End-to-end: real server + real extension in Chromium + mock chatgpt.com page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/server.js';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
const ROOT = path.resolve(import.meta.dirname, '..');
const PNG = fs.readFileSync(path.join(ROOT, 'public/icon.png'));
const MOCK = fs.readFileSync(path.join(ROOT, 'test/fixtures/mock-chatgpt.html'), 'utf8');
let srv, ctx, page, loggedIn = true;

before(async () => {
  if (!chromium) return;
  srv = startServer({ port: 18180, agentPort: 8081, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'imgt-')) });
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${ROOT}/extension`, `--load-extension=${ROOT}/extension`],
  });
  await ctx.route('https://chatgpt.com/**', (r) =>
    r.request().url().includes('/backend-api/')
      ? r.fulfill({ body: PNG, contentType: 'image/png' })
      : r.fulfill({ body: loggedIn ? MOCK : '<h1>Log in</h1>', contentType: 'text/html' }));
  page = await ctx.newPage();
  await page.goto('https://chatgpt.com/');
});
after(async () => { await ctx?.close(); srv?.close(); });

const waitJob = async (id) => {
  for (let i = 0; i < 480; i++) {
    const j = srv.store.get(id);
    if (j.status === 'done' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('job did not finish');
};
const img = `data:image/png;base64,${PNG.toString('base64')}`;

test('multi-angle job runs through ChatGPT tab and saves every image', { skip: !chromium }, async () => {
  const job = srv.store.create('angles', { product: img }, { angles: ['Front', 'Back'] });
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.outputs.length, 2);
  for (const o of done.outputs) assert.deepEqual(fs.readFileSync(path.join(srv.store.filesDir, job.id, o.file)), PNG);
});

test('two-image fabric job completes; ChatGPT refusal is reported as failure', { skip: !chromium }, async () => {
  const ok = srv.store.create('fabric', { furniture: img, fabric: img }, {});
  assert.equal((await waitJob(ok.id)).status, 'done');
  await page.waitForURL('https://chatgpt.com/'); // agent returned to a fresh chat (new document)
  const bad = srv.store.create('restyle', { furniture: img }, { notes: 'REFUSE' });
  const failed = await waitJob(bad.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.outputs[0].error, /can't create/);
});

test('logged-out page reports "login" state', { skip: !chromium }, async () => {
  loggedIn = false;
  await page.goto('https://chatgpt.com/');
  await page.waitForTimeout(3000);
  const state = await (await fetch('http://127.0.0.1:18180/api/state')).json();
  assert.equal(state.agent.state, 'login');
  assert.match(state.agent.note, /Prompt box not found on \/ .*Inputs seen: none/);
});
