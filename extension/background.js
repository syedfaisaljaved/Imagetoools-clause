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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (msg.download ? download(msg.download) : call(msg.path, msg.body)).then(reply, (e) => reply({ error: e.message }));
  return true; // async reply
});

// One window per site, side by side on the virtual screen (2560x960): ChatGPT left, Claude right.
// Separate windows both stay "visible", so neither page gets throttled or paused.
const W = 1280, H = 960;
const LAYOUT = [
  { match: 'https://chatgpt.com/', url: 'https://chatgpt.com/?temporary-chat=true' },
  { match: 'https://claude.ai/', url: 'https://claude.ai/new' },
];
async function arrange(createMissing) {
  const tabs = await chrome.tabs.query({});
  for (const [i, { match, url }] of LAYOUT.entries()) {
    const tab = tabs.find((t) => t.url?.startsWith(match));
    // Sharing a window with the other site would hide one of them: give the second site its own window.
    const shared = tab && i > 0 && tabs.some((t) => t.windowId === tab.windowId && t.url?.startsWith(LAYOUT[0].match));
    const windowId = !tab ? createMissing && (await chrome.windows.create({ url })).id
      : shared ? (await chrome.windows.create({ tabId: tab.id })).id
      : tab.windowId;
    // Bounds are applied after creation (create() rejects them while the screen is still initialising).
    if (windowId) await chrome.windows.update(windowId, { left: i * W, top: 0, width: W, height: H, state: 'normal' }).catch(() => {});
  }
}
// Missing windows are only created at startup: mid-login a tab may briefly be on another domain.
const arrangeSoon = () => setTimeout(() => arrange(true).catch(console.warn), 5000); // let startup tabs load first
chrome.runtime.onStartup.addListener(arrangeSoon);
chrome.runtime.onInstalled.addListener(arrangeSoon);
chrome.alarms.create('arrange', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => arrange(false).catch(console.warn));
