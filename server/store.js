// Job queue persisted as one JSON file + image files on disk.
// A job's steps are split into runs by site; each site's agent claims the next run whose turn it is.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildSteps } from './tools.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const sniffExt = (b) => (b[0] === 0xff ? 'jpg' : b.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : 'png');

export function createStore(dir) {
  const filesDir = path.join(dir, 'files');
  const dbFile = path.join(dir, 'jobs.json');
  fs.mkdirSync(filesDir, { recursive: true });
  let jobs = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : [];
  // The browser restarts with the server, so nothing can still be running.
  for (const j of jobs) if (j.status === 'running') Object.assign(j, { status: 'failed', error: 'Interrupted (server restarted)' });
  const save = () => {
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(jobs));
    fs.renameSync(dbFile + '.tmp', dbFile); // atomic replace
  };

  const get = (id) => jobs.find((j) => j.id === id);
  const update = (job, patch) => (Object.assign(job, patch, { updatedAt: Date.now() }), save(), job);
  const writeFile = (id, name, buf) => {
    fs.mkdirSync(path.join(filesDir, id), { recursive: true });
    fs.writeFileSync(path.join(filesDir, id, name), buf);
    return name;
  };
  const siteOf = (job) => job.steps[job.outputs.length]?.site;

  return {
    filesDir,
    list: () => jobs,
    get,

    // images: { key: dataURL | dataURL[] } → inputs: { key: file | file[] }
    create(tool, images, options) {
      const steps = buildSteps(tool, images, options);
      const id = randomUUID().slice(0, 8);
      const inputs = {};
      for (const [key, value] of Object.entries(images)) {
        const files = [value].flat().map((url, i) => {
          const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(url || '');
          if (!m) throw new Error(`Image "${key}" must be PNG, JPG or WEBP`);
          return writeFile(id, `in-${key}${Array.isArray(value) ? '-' + i : ''}.${EXT[m[1]]}`, Buffer.from(m[2], 'base64'));
        });
        inputs[key] = Array.isArray(value) ? files : files[0];
      }
      const job = { id, tool, options, inputs, steps, status: 'queued', outputs: [], createdAt: Date.now(), updatedAt: Date.now() };
      jobs.unshift(job);
      save();
      return job;
    },

    // Returns { job, from, to } — the consecutive steps this site should run now in one chat.
    // A job still "running" for the tab (agent) asking for work was interrupted (page reload / crash);
    // one silent for 15 min lost its tab.
    claimNext(site = 'chatgpt', agent = '') {
      for (const j of jobs) {
        if (j.status === 'running' && (j.agent === agent || Date.now() - j.updatedAt > 15 * 60e3)) update(j, { status: 'failed', error: 'Interrupted (browser reloaded)' });
      }
      const job = jobs.findLast((j) => j.status === 'queued' && siteOf(j) === site);
      if (!job) return null;
      const from = job.outputs.length;
      let to = from;
      while (job.steps[to]?.site === site) to++;
      update(job, { status: 'running', agent });
      return { job, from, to };
    },

    addOutput(id, step, { image, text, error }) {
      const job = get(id);
      if (!job || job.status !== 'running') throw new Error('Job not running');
      const buf = image && Buffer.from(image, 'base64');
      const out = buf ? { step, file: writeFile(id, `out-${step}-${Date.now()}.${sniffExt(buf)}`, buf) } : text ? { step, text } : { step, error };
      return update(job, { outputs: [...job.outputs, out] });
    },

    // Ends the current run. More steps left → back to the queue for the next site.
    finish(id, error) {
      const job = get(id);
      if (!job) throw new Error('Not found');
      const textFailed = job.outputs.find((o) => o.error && job.steps[o.step].site === 'claude');
      if (error || textFailed) return update(job, { status: 'failed', error: error || textFailed.error });
      if (job.outputs.length < job.steps.length) return update(job, { status: 'queued' });
      const ok = job.outputs.some((o) => o.file);
      return update(job, { status: ok ? 'done' : 'failed', error: ok ? undefined : 'No image was generated' });
    },

    // Last Claude reply, used for '{{text}}' in later prompts.
    lastText: (job) => job.outputs.findLast((o) => o.text)?.text || '',

    retry(id) {
      const job = get(id);
      if (!job || job.status === 'running') throw new Error('Cannot retry');
      return update(job, { status: 'queued', outputs: [], error: undefined, createdAt: Date.now() });
    },

    remove(id) {
      jobs = jobs.filter((j) => j.id !== id);
      fs.rmSync(path.join(filesDir, id), { recursive: true, force: true });
      save();
    },
  };
}
