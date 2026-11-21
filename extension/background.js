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

// One full-screen window per site on the 1280x960 virtual screen, stacked; the app's buttons bring one to front.
// Separate windows (not tabs) both stay "visible", so neither page gets throttled or paused.
const W = 1280, H = 960;
const LAYOUT = [
  { match: 'https://chatgpt.com/', url: 'https://chatgpt.com/?temporary-chat=true' },
  { match: 'https://claude.ai/', url: 'https://claude.ai/new' },
];
const missing = {}; // consecutive runs a site had no tab
async function arrange(startup) {
  const tabs = await chrome.tabs.query({});
  for (const [i, { match, url }] of LAYOUT.entries()) {
    const site = tabs.filter((t) => (t.url || t.pendingUrl)?.startsWith(match));
    // Idle duplicates (e.g. restored after a crash) just compete for jobs: close them.
    for (const dup of site.slice(1)) if (dup.url === url) await chrome.tabs.remove(dup.id).catch(() => {});
    const tab = site[0];
    // Mid-login a tab is briefly on another domain: only re-create a window at startup or after 3 empty minutes.
    missing[match] = tab ? 0 : (missing[match] || 0) + 1;
    if (!tab && !startup && missing[match] < 3) continue;
    // Sharing a window with the other site would hide one of them: give the second site its own window.
    const shared = tab && i > 0 && tabs.some((t) => t.windowId === tab.windowId && t.url?.startsWith(LAYOUT[0].match));
    const windowId = !tab ? (await chrome.windows.create({ url })).id
      : shared ? (await chrome.windows.create({ tabId: tab.id })).id
      : tab.windowId;
    // Bounds are applied after creation (create() rejects them while the screen is still initialising).
    await chrome.windows.update(windowId, { left: 0, top: 0, width: W, height: H, state: 'normal' }).catch(() => {});
  }
}
// Runs whenever the worker starts and then every minute (the tabs' polling keeps the worker alive).
const safeArrange = (startup) => arrange(startup).catch((e) => console.warn('[ImageTools] arrange', e));
setTimeout(() => safeArrange(true), 5000); // let startup tabs load first
setInterval(() => safeArrange(false), 60e3);
