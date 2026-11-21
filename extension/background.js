// Bridge between the ChatGPT/Claude tabs and the local agent API (extension context avoids page CORS limits).
const AGENT = 'http://127.0.0.1:8081';

const call = async (path, body) => {
  const r = await fetch(AGENT + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
};

// Fallback image download when the page itself can't fetch the URL.
const download = async (url) => {
  const bytes = new Uint8Array(await (await fetch(url, { credentials: 'include' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(s) };
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.focus) return void chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {}); // bring to front
  (msg.download ? download(msg.download) : call(msg.path, msg.body)).then(reply, (e) => reply({ error: e.message }));
  return true; // async reply
});

// `parallel` full-screen windows per site on the 1280x960 virtual screen, stacked; each window's tab runs its own
// job, so a site runs that many jobs at once. Separate windows (not tabs) all stay "visible", so none is paused.
// The app's status buttons bring a site's window to the front.
const W = 1280, H = 960;
const LAYOUT = [
  { match: 'https://chatgpt.com/', url: 'https://chatgpt.com/' },
  { match: 'https://claude.ai/', url: 'https://claude.ai/new' },
];
const short = {}; // consecutive runs a site had too few tabs
async function arrange(startup) {
  const { parallel = 1 } = await call('/agent/config').catch(() => ({}));
  let tabs = await chrome.tabs.query({});
  const ours = (t) => LAYOUT.some((l) => (t.url || t.pendingUrl)?.startsWith(l.match));
  // Only the active tab of a window works: give every extra agent tab its own window.
  for (const t of tabs.filter(ours)) {
    if (tabs.some((o) => o.windowId === t.windowId && o.index < t.index && ours(o))) await chrome.windows.create({ tabId: t.id }).catch(() => {});
  }
  tabs = await chrome.tabs.query({});
  for (const { match, url } of LAYOUT) {
    const site = tabs.filter((t) => (t.url || t.pendingUrl)?.startsWith(match));
    // More than needed (e.g. PARALLEL lowered): close idle extras sitting on the home page.
    for (const t of site.slice(parallel)) if (t.url === url) await chrome.tabs.remove(t.id).catch(() => {});
    // Mid-login a tab is briefly on another domain: only add windows at startup or after 3 short minutes.
    short[match] = site.length < parallel ? (short[match] || 0) + 1 : 0;
    if (startup || short[match] >= 3) for (let i = site.length; i < parallel; i++) await chrome.windows.create({ url });
  }
  // Bounds are applied after creation (create() rejects them while the screen is still initialising),
  // and only when they differ: any update raises the window above the one the user is looking at.
  const off = (a, b) => Math.abs(a - b) > 20; // Chromium reports e.g. 1279 for 1280
  for (const win of await chrome.windows.getAll()) {
    if (off(win.left, 0) || off(win.top, 0) || off(win.width, W) || off(win.height, H) || win.state !== 'normal') {
      await chrome.windows.update(win.id, { left: 0, top: 0, width: W, height: H, state: 'normal' }).catch(() => {});
    }
  }
}
// Runs whenever the worker starts and then every minute (the tabs' polling keeps the worker alive).
const safeArrange = (startup) => arrange(startup).catch((e) => console.warn('[ImageTools] arrange', e));
setTimeout(() => safeArrange(true), 5000); // let startup tabs load first
setInterval(() => safeArrange(false), 60e3);
