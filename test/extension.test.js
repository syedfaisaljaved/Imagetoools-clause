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
const GEN = fs.readFileSync(path.join(ROOT, 'server/assets/factory.jpg')); // what the mock 'generates'
const MOCK = fs.readFileSync(path.join(ROOT, 'test/fixtures/mock-chatgpt.html'), 'utf8');
const MOCK_CLAUDE = fs.readFileSync(path.join(ROOT, 'test/fixtures/mock-claude.html'), 'utf8');
const deleted = []; // chat-delete API calls seen
let srv, ctx, page, loggedIn = true;

before(async () => {
  if (!chromium) return;
  srv = startServer({ port: 18180, agentPort: 8081, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'imgt-')), parallel: 2 });
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${ROOT}/extension`, `--load-extension=${ROOT}/extension`],
  });
  await ctx.route('https://chatgpt.com/**', (r) => {
    const url = r.request().url();
    if (url.includes('/api/auth/session')) return r.fulfill({ json: { accessToken: 'tok' } });
    if (r.request().method() === 'PATCH') return deleted.push(`chatgpt ${url.split('/').pop()} ${r.request().headers().authorization}`), r.fulfill({ json: {} });
    const gens = Array.from({ length: 9 }, (_, i) => `file_gen${i + 1}`);
    if (url.includes('/my/recent/image_gen')) return r.fulfill({ json: { items: gens.map((f) => ({ conversation_id: 'abc', url: `https://chatgpt.com/backend-api/estuary/content?id=${f}&sig=x` })) } });
    if (url.endsWith('/backend-api/files/library')) {
      const now = new Date().toISOString(), old = '2020-01-01T00:00:00Z';
      const items = [...gens.map((f) => ({ file_id: f, file_name: `${f}.png`, record_creation_time: now })),
        { file_id: 'file_up', file_name: `${srv.store.list()[0]?.id}-in-product.png`, record_creation_time: now }, // latest job's upload
        { file_id: 'file_old', file_name: 'in-product.png', record_creation_time: old }]; // the user's older file: keep
      return r.fulfill({ json: { cursor: null, items: items.map((i) => ({ ...i, id: `libfile_${i.file_id}`, directory_id: 'libdir_root' })) } });
    }
    if (url.endsWith('/delete-batch')) return deleted.push(`library ${JSON.parse(r.request().postData()).files.map((f) => f.library_file_id).sort()}`), r.fulfill({ json: {} });
    if (url.includes('file_gen')) return r.fulfill({ body: GEN, contentType: 'image/jpeg' });
    if (url.includes('/backend-api/')) return r.fulfill({ body: PNG, contentType: 'image/png' });
    r.fulfill({ body: loggedIn ? MOCK : '<h1>Log in</h1>', contentType: 'text/html' });
  });
  await ctx.route('https://claude.ai/**', (r) => {
    const url = r.request().url();
    if (url.endsWith('/api/organizations')) return r.fulfill({ json: [{ uuid: 'org-1' }] });
    if (r.request().method() === 'DELETE') return deleted.push(`claude ${url.split('/').slice(-3).join('/')}`), r.fulfill({ json: {} });
    r.fulfill({ body: MOCK_CLAUDE, contentType: 'text/html' });
  });
  page = await ctx.newPage();
  await page.goto('https://chatgpt.com/');
  // The extension opens the other windows (2 per site) by itself; wait for them, then reload each one,
  // because windows opened by the extension skip Playwright routing on their first load.
  const site = (host) => ctx.pages().filter((p) => p.url().includes(host));
  for (let i = 0; i < 80 && (site('chatgpt.com').length < 2 || site('claude.ai').length < 2); i++) await new Promise((r) => setTimeout(r, 250));
  for (const p of [...site('chatgpt.com'), ...site('claude.ai')]) if (p !== page) await p.goto(p.url().includes('claude') ? 'https://claude.ai/new' : 'https://chatgpt.com/');
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
  for (const o of done.outputs) assert.deepEqual(fs.readFileSync(path.join(srv.store.filesDir, job.id, o.file)), GEN); // never the upload
  assert.ok(deleted.includes('chatgpt abc Bearer tok'), 'ChatGPT chat deleted after the job');
  const lib = deleted.find((d) => d.startsWith('library'));
  assert.ok(lib?.includes('libfile_file_gen1') && lib.includes('libfile_file_up') && !lib.includes('file_old'), `library files deleted: ${deleted}`);
  assert.match((await (await fetch('http://127.0.0.1:18180/api/logs')).json()).join('\n'), new RegExp(`${job.id} library: deleted`));
});

test('drawing job: Claude writes the prompt from all photos, ChatGPT draws it, both chats deleted', { skip: !chromium }, async () => {
  const job = srv.store.create('outline', { photos: [img, img] }, {});
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.outputs[0].text, 'Technical line drawing of the sofa from 2 photos');
  assert.ok(done.outputs[1].file);
  assert.ok(deleted.includes('claude org-1/chat_conversations/conv-1'), 'Claude chat deleted');
});

test('two-image fabric job completes; ChatGPT refusal is reported as failure', { skip: !chromium }, async () => {
  const ok = srv.store.create('fabric', { furniture: img, fabric: img }, {});
  assert.equal((await waitJob(ok.id)).status, 'done');
  await page.waitForURL('https://chatgpt.com/'); // agent returned to a fresh chat
  const bad = srv.store.create('restyle', { furniture: img }, { notes: 'REFUSE' });
  const failed = await waitJob(bad.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.outputs[0].error, /can't create/);
});

test('jobs run in parallel, one per window', { skip: !chromium }, async () => {
  const jobs = [1, 2].map(() => srv.store.create('restyle', { furniture: img }, {}));
  let together = false;
  for (let i = 0; i < 120 && !together; i++) {
    together = jobs.every((j) => srv.store.get(j.id).status === 'running');
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(together, 'both jobs were running at the same time');
  const state = await (await fetch('http://127.0.0.1:18180/api/state')).json();
  assert.equal(state.agents.chatgpt.tabs, 2);
  for (const j of jobs) assert.equal((await waitJob(j.id)).status, 'done');
});

test('logged-out page reports "login" state', { skip: !chromium }, async () => {
  loggedIn = false;
  for (const p of ctx.pages().filter((p) => p.url().includes('chatgpt.com'))) await p.goto('https://chatgpt.com/');
  await page.waitForTimeout(16000); // a fresh "ready" from the same site is trusted for 10s
  const state = await (await fetch('http://127.0.0.1:18180/api/state')).json();
  assert.equal(state.agents.chatgpt.state, 'login');
  assert.match(state.agents.chatgpt.note, /Prompt box not found on \/ .*Inputs seen: none/);
});
