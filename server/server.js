// Zero-dependency HTTP server.
//  - Public app (PORT): UI, jobs API, results, /vnc/ proxy. Protected by APP_PASSWORD cookie login.
//  - Agent API (AGENT_PORT, bound to 127.0.0.1): used only by the Chrome extension on the same machine.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { toolSchemas } from './tools.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export function startServer({ port = 8080, agentPort = 8081, dataDir = path.join(ROOT, 'data'), password = '', vncPort = 6080, parallel = 3 } = {}) {
  const store = createStore(dataDir);
  const SITES = ['chatgpt', 'claude'];
  // Each browser tab is one agent; a site runs as many jobs at once as it has working tabs.
  const agents = Object.fromEntries(SITES.map((s) => [s, new Map()])); // site → agentId → { state, note, lastSeen }
  const siteParam = (url) => (SITES.includes(url.searchParams.get('site')) ? url.searchParams.get('site') : 'chatgpt');
  const seen = (url, patch) => {
    const tabs = agents[siteParam(url)], id = url.searchParams.get('agent') || '';
    tabs.set(id, { ...tabs.get(id), ...patch, lastSeen: Date.now() });
  };
  const token = password && createHash('sha256').update('imgtools:' + password).digest('hex');

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const sendFile = (res, file) =>
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  const readJson = (req, limit = 60e6) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => ((size += c.length) > limit ? req.destroy(new Error('Body too large')) : chunks.push(c)));
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  const authed = (req) => {
    if (!token) return true;
    const c = /(?:^|;\s*)auth=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    return !!c && timingSafeEqual(Buffer.from(c), Buffer.from(token));
  };
  // The steps of one run as the extension needs them: prompts (with {{text}} filled) + input images as base64.
  const agentJob = ({ job, from, to }) => ({
    id: job.id,
    steps: job.steps.slice(from, to).map(({ prompt, images }, i) => ({
      index: from + i,
      prompt: prompt.replaceAll('{{text}}', store.lastText(job)),
      images: images.flatMap((key) => [job.inputs[key]].flat()).map((name) => ({
        name: `${job.id}-${name}`, // unique per job, so parallel jobs' library cleanups never touch each other's uploads
        type: TYPES[path.extname(name)],
        data: fs.readFileSync(path.join(store.filesDir, job.id, name)).toString('base64'),
      })),
    })),
  });
  // Per site: working tabs (ready/busy) win over tabs stuck on a login page.
  const agentStatus = () => Object.fromEntries(SITES.map((s) => {
    for (const [id, a] of agents[s]) if (Date.now() - a.lastSeen > 300e3) agents[s].delete(id);
    const alive = [...agents[s].values()].filter((a) => Date.now() - a.lastSeen < 20e3);
    const working = alive.filter((a) => a.state !== 'login');
    const busy = working.filter((a) => a.state === 'busy').length;
    const state = working.length ? (busy === working.length ? 'busy' : 'ready') : alive.length ? 'login' : 'offline';
    return [s, { state, tabs: working.length, busy, note: state === 'login' ? alive[0].note : '' }];
  }));
  // Site whose window the user wants in front of the remote screen; handed to that site's tab on its next poll.
  let front = null;
  // Recent agent log lines (cleanup results, failures) for remote debugging: GET /api/logs.
  const logs = [];
  const takeFront = (site) => front === site && !(front = null);

  // Routes: [method, regex, handler(req, res, url, ...params)]
  const appRoutes = [
    ['GET', /^\/api\/state$/, (req, res) => send(res, 200, { tools: toolSchemas, jobs: store.list().map(publicJob), agents: agentStatus() })],
    ['POST', /^\/api\/jobs$/, async (req, res) => {
      const { tool, images, options } = await readJson(req);
      send(res, 201, publicJob(store.create(tool, images, options)));
    }],
    ['GET', /^\/api\/logs$/, (req, res) => send(res, 200, logs)],
    ['POST', /^\/api\/front$/, async (req, res) => {
      const { site } = await readJson(req, 1e3);
      front = SITES.includes(site) ? site : null;
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/jobs\/(\w+)\/retry$/, (req, res, url, id) => send(res, 200, publicJob(store.retry(id)))],
    ['DELETE', /^\/api\/jobs\/(\w+)$/, (req, res, url, id) => (store.remove(id), send(res, 200, { ok: true }))],
    ['GET', /^\/files\/(\w+)\/([\w.-]+)$/, (req, res, url, id, name) => sendFile(res, path.join(store.filesDir, id, name))],
    ['GET', /^\/vnc\//, (req, res) => proxyHttp(req, res)],
    ['GET', /^\/(?:([\w-]+\.\w+))?$/, (req, res, url, f = 'index.html') => sendFile(res, path.join(PUBLIC, f))],
  ];

  const agentRoutes = [
    ['GET', /^\/agent\/next$/, (req, res, url) => {
      const site = siteParam(url), run = store.claimNext(site, url.searchParams.get('agent') || '');
      seen(url, { state: run ? 'busy' : 'ready', note: '' });
      send(res, 200, { job: run ? agentJob(run) : null, front: takeFront(site) });
    }],
    ['POST', /^\/agent\/status$/, async (req, res, url) => {
      const { state, note = '' } = await readJson(req);
      seen(url, { state, note: String(note).slice(0, 300) });
      send(res, 200, { ok: true, front: takeFront(siteParam(url)) });
    }],
    ['GET', /^\/agent\/config$/, (req, res) => send(res, 200, { parallel })],
    ['POST', /^\/agent\/log$/, async (req, res, url) => {
      const { msg } = await readJson(req, 1e4);
      logs.push(`${new Date().toISOString()} ${siteParam(url)}: ${String(msg).slice(0, 500)}`);
      logs.splice(0, logs.length - 100);
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/agent\/jobs\/(\w+)\/output$/, async (req, res, url, id) => {
      const { step, image, text, error } = await readJson(req);
      seen(url, {});
      store.addOutput(id, step, { image, text: text && String(text).slice(0, 20000), error });
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/agent\/jobs\/(\w+)\/finish$/, async (req, res, url, id) => {
      const { error } = await readJson(req);
      store.finish(id, error);
      send(res, 200, { ok: true });
    }],
  ];

  const router = (routes, guard) => async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (guard && !(await guard(req, res, url))) return;
      for (const [method, re, handler] of routes) {
        const m = req.method === method && re.exec(url.pathname);
        if (m) return await handler(req, res, url, ...m.slice(1).filter((x) => x !== undefined));
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: e.message });
    }
  };

  // Login gate: unauthenticated users get the login page; POST /login sets the cookie.
  const guard = async (req, res, url) => {
    if (url.pathname === '/login' && req.method === 'POST') {
      const { password: p } = await readJson(req, 1e4);
      if (p !== password) return send(res, 401, { error: 'Wrong password' }), false;
      res.setHeader('Set-Cookie', `auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return send(res, 200, { ok: true }), false;
    }
    if (authed(req) || /^\/(?:login\.html|style\.css|icon\.png)$/.test(url.pathname)) return true;
    if (req.method === 'GET' && url.pathname === '/') return sendFile(res, path.join(PUBLIC, 'login.html')), false;
    return send(res, 401, { error: 'Login required' }), false;
  };

  // noVNC (websockify on vncPort) is exposed under /vnc/ so the login also protects the remote browser.
  const proxyHttp = (req, res) => {
    const up = http.request({ port: vncPort, path: req.url.slice(4), method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => send(res, 502, { error: 'Remote browser not running' }));
    req.pipe(up);
  };

  const app = http.createServer(router(appRoutes, guard));
  app.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/vnc/') || !authed(req)) return socket.destroy();
    const up = net.connect(vncPort, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      up.write(`GET ${req.url.slice(4)} HTTP/1.1\r\n${headers}\r\n\r\n`);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  const agentServer = http.createServer(router(agentRoutes));
  app.listen(port);
  agentServer.listen(agentPort, '127.0.0.1');
  return { store, app, agentServer, close: () => (app.close(), agentServer.close()) };
}

const publicJob = ({ steps, ...j }) => ({ ...j, total: steps.length });
