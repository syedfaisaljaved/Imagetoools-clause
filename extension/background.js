// Bridge between the ChatGPT tab and the local agent API (extension context avoids page CORS limits).
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

// Keep one window per site (separate windows stay "visible", so neither gets throttled).
const SITES = { 'https://chatgpt.com/*': 'https://chatgpt.com/', 'https://claude.ai/*': 'https://claude.ai/new' };
async function ensureWindows() {
  await new Promise((r) => setTimeout(r, 5000)); // let startup tabs load first
  for (const [pattern, url] of Object.entries(SITES)) {
    if (!(await chrome.tabs.query({ url: pattern })).length) await chrome.windows.create({ url, width: 1280, height: 900 });
  }
}
chrome.runtime.onStartup.addListener(ensureWindows);
chrome.runtime.onInstalled.addListener(ensureWindows);
