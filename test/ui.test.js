// Browser test of the web UI against the real server (agent simulated over its HTTP API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/server.js';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
const ICON = path.resolve(import.meta.dirname, '../public/icon.png');
const URL = 'http://127.0.0.1:18280';
let srv, browser, page;

before(async () => {
  if (!chromium) return;
  srv = startServer({ port: 18280, agentPort: 18281, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'imgt-')), password: 'secret' });
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => { await browser?.close(); srv?.close(); });

test('login, then validation error when an image is missing', { skip: !chromium }, async () => {
  await page.goto(URL);
  await page.fill('input[type=password]', 'wrong');
  await page.click('button');
  await page.getByText('Wrong password').waitFor();
  await page.fill('input[type=password]', 'secret');
  await page.click('button');
  await page.locator('#agents [data-site=chatgpt][data-state=offline]').waitFor();
  await page.click('#tabs >> text=Apply fabric');
  await page.setInputFiles('.upload[data-key=furniture] input', ICON);
  await page.locator('.upload[data-key=furniture] .thumb').waitFor(); // preview shown
  await page.click('#go');
  await page.getByText('Missing image: Fabric photo').waitFor();
});

test('photos can be removed; prompt stays collapsed under Advanced', { skip: !chromium }, async () => {
  await page.click('#tabs >> text=Furniture drawing');
  await page.setInputFiles('.upload[data-key=photos] input', [ICON, ICON]);
  await page.locator('.upload[data-key=photos] .thumb >> nth=1').waitFor();
  await page.click('.upload[data-key=photos] [data-remove="0"]');
  assert.equal(await page.locator('.upload[data-key=photos] .thumb').count(), 1);
  assert.equal(await page.locator('textarea[name=instructions]').isVisible(), false);
  await page.click('#advanced summary');
  assert.equal(await page.locator('textarea[name=instructions]').isVisible(), true);
});

test('submit restyle job → agent finishes it → result thumbnail shown', { skip: !chromium }, async () => {
  await page.click('#tabs >> text=Restyle');
  await page.setInputFiles('.upload[data-key=furniture] input', ICON);
  await page.locator('.upload[data-key=furniture] .thumb').waitFor();
  await page.selectOption('select[name=fabric]', 'Boucle');
  await page.fill('input[name=color]', 'cream');
  await page.click('#go');
  await page.locator('.badge.queued').waitFor();

  const agent = (p, body) => fetch('http://127.0.0.1:18281' + p, body ? { method: 'POST', body: JSON.stringify(body) } : {}).then((r) => r.json());
  const { job } = await agent('/agent/next');
  assert.match(job.steps[0].prompt, /boucle.*cream/s);
  await agent(`/agent/jobs/${job.id}/output`, { step: 0, image: fs.readFileSync(ICON).toString('base64') });
  await agent(`/agent/jobs/${job.id}/finish`, {});

  await page.locator('.badge.done').waitFor({ timeout: 8000 });
  assert.equal(await page.locator('img[alt="result 1"]').count(), 1);
  assert.equal(await page.locator('#agents [data-site=chatgpt]').getAttribute('data-state'), 'busy'); // agent last reported busy
  await page.click('img[alt="result 1"]');
  assert.equal(await page.locator('#viewer').isVisible(), true); // tap a result → full-screen viewer
  await page.click('#viewer [data-close]');
  await page.click('.job .ins button >> nth=0'); // uploaded photo opens in the same viewer
  assert.match(await page.locator('#viewer-img').getAttribute('src'), /in-furniture\.png$/);
  await page.click('#viewer [data-use=wood]'); // send it to another tool
  await page.locator('.upload[data-key=product] .thumb').waitFor();
  assert.equal(await page.locator('.tab[aria-selected=true]').textContent(), 'Raw wood');
});
