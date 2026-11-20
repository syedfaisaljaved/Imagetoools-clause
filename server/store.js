// Job queue persisted as one JSON file + image files on disk. Single agent → FIFO, one job at a time.
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

  return {
    filesDir,
    list: () => jobs,
    get,

    // images: { key: dataURL }
    create(tool, images, options) {
      const steps = buildSteps(tool, images, options);
      const id = randomUUID().slice(0, 8);
      const inputs = {};
      for (const [key, url] of Object.entries(images)) {
        const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(url || '');
        if (!m) throw new Error(`Image "${key}" must be PNG, JPG or WEBP`);
        inputs[key] = writeFile(id, `in-${key}.${EXT[m[1]]}`, Buffer.from(m[2], 'base64'));
      }
      const job = { id, tool, options, inputs, steps, status: 'queued', outputs: [], createdAt: Date.now(), updatedAt: Date.now() };
      jobs.unshift(job);
      save();
      return job;
    },

    // Anything still "running" when the agent asks for work was interrupted (page reload / crash).
    claimNext() {
      for (const j of jobs) if (j.status === 'running') update(j, { status: 'failed', error: 'Interrupted (browser reloaded)' });
      const next = jobs.findLast((j) => j.status === 'queued');
      return next && update(next, { status: 'running', outputs: [], error: undefined });
    },

    addOutput(id, step, { image, error }) {
      const job = get(id);
      if (!job || job.status !== 'running') throw new Error('Job not running');
      const buf = image && Buffer.from(image, 'base64');
      const out = buf ? { step, file: writeFile(id, `out-${step}-${Date.now()}.${sniffExt(buf)}`, buf) } : { step, error };
      return update(job, { outputs: [...job.outputs, out] });
    },

    finish(id, error) {
      const job = get(id);
      if (!job) throw new Error('Not found');
      const ok = !error && job.outputs.some((o) => o.file);
      return update(job, { status: ok ? 'done' : 'failed', error: ok ? undefined : error || 'No image was generated' });
    },

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
