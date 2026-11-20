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
