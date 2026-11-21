// Runs inside the chatgpt.com / claude.ai tab: polls the server for work on this site and does it like a user would.
// If a site changes its page, usually only its selectors below need updating.
// `home` is where every job starts. (ChatGPT's temporary chats can't generate images, so jobs use normal chats
// and clean up after themselves — see deleteChat.)
const SITE = location.hostname.endsWith('claude.ai') ? 'claude' : 'chatgpt';
const SEL = {
  chatgpt: {
    home: '/',
    leave: /^\/(c\/|$)/, // finished chat, or '/' with extra query params
    editor: '#prompt-textarea, .ProseMirror[contenteditable="true"], textarea[name="prompt-textarea"], form [contenteditable="true"], form textarea',
    send: '[data-testid="send-button"], #composer-submit-button, button[aria-label*="send" i]',
    busy: '[data-testid="stop-button"], button[aria-label*="stop" i]',
    user: '[data-message-author-role="user"]',
    reply: '[data-message-author-role="assistant"]',
  },
  claude: {
    home: '/new',
    leave: /^\/(chat\/|$)/,
    editor: '.ProseMirror[contenteditable="true"], [contenteditable="true"], textarea',
    send: 'button[aria-label*="send" i]',
    busy: 'button[aria-label*="stop" i], [data-is-streaming="true"]',
    reply: '[data-is-streaming], .font-claude-response, .font-claude-message',
  },
}[SITE];
const POLL_MS = 3000;
// Stable per tab across reloads, so the server can tell a reloaded tab from a second tab.
const AGENT_ID = sessionStorage.imagetoolsAgent ||= Math.random().toString(36).slice(2);
const STEP_TIMEOUT = 8 * 60e3; // image generation can be slow on busy hours

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, body) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await chrome.runtime.sendMessage({ path: `${path}${sep}site=${SITE}&agent=${AGENT_ID}`, body });
  if (r?.error) throw new Error(r.error);
  if (r?.front) chrome.runtime.sendMessage({ focus: true }); // user asked to see this site's window
  return r;
}

async function waitFor(fn, timeout, every = 500) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(every)) {
    const v = fn();
    if (v) return v;
  }
  return null;
}

// What the agent sees: shown in the app so selector problems can be diagnosed remotely.
const diagnose = () => {
  const els = $$('textarea, [contenteditable="true"]').map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).split(' ')[0] : ''}`);
  return `Prompt box not found on ${location.pathname} ("${document.title}"). Inputs seen: ${els.join(', ') || 'none'}`;
};

// Text of the latest reply (its markdown body when there is one, skipping screen-reader summaries).
const lastReply = () => {
  const r = $$(SEL.reply).at(-1);
  return ((SITE === 'claude' && r?.querySelector('.standard-markdown, .font-claude-response')) || r)?.innerText.trim() || '';
};

function attach(images) {
  const dt = new DataTransfer();
  for (const { name, type, data } of images) dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type }));
  const input = $('input[type="file"]');
  if (!input) throw new Error('Upload button not found');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function type(text) {
  const editor = $(SEL.editor);
  editor.focus();
  document.execCommand('selectAll');
  document.execCommand('insertText', false, text);
  if (!editor.innerText.includes(text.slice(0, 30)) && !editor.value?.includes(text.slice(0, 30))) {
    // execCommand needs a focused window; a paste event works in background windows too.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
}

async function send(text) {
  type(text);
  // Send stays disabled while uploads are in progress.
  const btn = await waitFor(() => { const b = $(SEL.send); return b && !b.disabled && b; }, 120e3);
  if (!btn) throw new Error('Send button never became ready (upload failed?)');
  btn.click();
}

async function waitReply() {
  await waitFor(() => $(SEL.busy), 15e3); // reply started (may be too quick to catch — fine)
  if (!(await waitFor(() => !$(SEL.busy), STEP_TIMEOUT, 1000))) throw new Error(`Timed out waiting for ${SITE}`);
}

const submit = async (text) => (await send(text), waitReply());

// ---------- ChatGPT: image steps ----------

// Candidate result images, never our uploads (alt "Uploaded image", composer previews, user turns).
const isUpload = (img) =>
  /upload/i.test(img.alt) || img.closest('form') || img.closest(SEL.user) || img.closest('article, [data-testid^="conversation-turn"]')?.querySelector(SEL.user);
const resultImages = () => {
  const imgs = $$('main img').filter((img) => !isUpload(img));
  const generated = imgs.filter((img) => /generated image/i.test(img.alt));
  return generated.length ? generated : imgs.filter((img) => img.naturalWidth >= 400);
};

// Waits for an image not in `before` whose src stops changing (progressive previews settle into the final image).
// Gives up after 90s if no new image appeared at all (image tool may start after the text reply).
async function settledImage(before) {
  const start = Date.now();
  let last, stable = 0;
  return waitFor(() => {
    const cur = resultImages().filter((i) => !before.has(i.src)).at(-1);
    if (!cur && Date.now() - start > 90e3) return 'none';
    if (cur?.complete && cur.naturalWidth && cur.src === last) return ++stable >= 3 && cur;
    last = cur?.src;
    stable = 0;
  }, 180e3, 1000).then((r) => (r === 'none' ? null : r));
}

// Base64 of the new result image; an image identical in size to one we uploaded is skipped, never returned.
async function newImage(before, uploadSizes) {
  for (let img; (img = await settledImage(before)); before.add(img.src)) {
    const data = await toBase64(img.src);
    if (!uploadSizes.has(data.length)) return data;
  }
  return null;
}

async function toBase64(src) {
  try {
    const blob = await (await fetch(src, { credentials: 'include' })).blob();
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result.split(',')[1]);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch {
    return (await chrome.runtime.sendMessage({ download: src })).data;
  }
}

async function imageStep(step, uploadSizes) {
  if (step.images.length) attach(step.images);
  await send(step.prompt);
  await sleep(3000); // our message and its uploads are on screen now: nothing visible yet is a result
  const before = new Set($$('main img').map((i) => i.src));
  await waitReply();
  let image = await newImage(before, uploadSizes);
  if (!image && !/limit|try again|can't|cannot|unable|not available/i.test(lastReply())) {
    await submit('Yes — generate the image now exactly as described.'); // ChatGPT sometimes asks for confirmation
    image = await newImage(before, uploadSizes);
  }
  if (!image) throw new Error(lastReply().slice(0, 400) || 'No image was generated');
  return { image };
}

// ---------- Claude: text steps ----------

async function textStep(step) {
  const before = $$(SEL.reply).length;
  if (step.images.length) attach(step.images);
  await submit(step.prompt);
  // Wait for a new reply whose text has stopped changing.
  let last = '', stable = 0;
  const text = await waitFor(() => {
    const t = $$(SEL.reply).length > before ? lastReply() : '';
    stable = t && t === last ? stable + 1 : 0;
    last = t;
    return stable >= 3 && t;
  }, 60e3, 1000);
  if (!text) throw new Error('Claude gave no reply');
  return { text: text.replace(/^Claude responded:[^\n]*\n+/, '').replace(/^```\w*\n?|```$/g, '').trim() };
}

// ---------- Cleanup: delete the chat and its images so history / image library don't fill up ----------

// ChatGPT files shown in this chat (our uploads + generated images), by their file id.
const chatFileIds = () =>
  new Set($$('main img').map((img) => { try { return new URL(img.src).searchParams.get('id'); } catch { return null; } }).filter((id) => id?.startsWith('file')));

// Moves those files from ChatGPT's library to its trash (auto-emptied after 30 days).
// The library indexes new files with a short delay, so look a few times.
async function deleteLibraryFiles(ids, headers) {
  for (let attempt = 0; attempt < 4 && ids.size; attempt++) {
    if (attempt) await sleep(5000);
    const found = [];
    let cursor = null;
    for (let page = 0; page < 10 && found.length < ids.size; page++) {
      const r = await (await fetch('/backend-api/files/library', {
        method: 'POST', headers,
        body: JSON.stringify({ cursor, limit: 50, categories: [], include_hidden_files: true, include_saved_entities: true, include_sites: false, providers: [], ranking: 'suggested', source: null, trashed_only: false }),
      })).json();
      found.push(...(r.items || []).filter((i) => ids.has(i.file_id)));
      if (!(cursor = r.cursor)) break;
    }
    if (!found.length) continue;
    await fetch('/backend-api/files/library/files/delete-batch', {
      method: 'POST', headers,
      body: JSON.stringify({ files: found.map((i) => ({ library_file_id: i.id, file_id: i.file_id, parent_directory_id: i.directory_id, file_name: i.file_name })) }),
    });
    for (const i of found) ids.delete(i.file_id);
  }
}

async function deleteChat() {
  try {
    if (SITE === 'chatgpt') {
      const { accessToken } = await (await fetch('/api/auth/session')).json();
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` };
      const id = location.pathname.match(/\/c\/([\w-]+)/)?.[1];
      if (id) await fetch(`/backend-api/conversation/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ is_visible: false }) });
      await deleteLibraryFiles(chatFileIds(), headers);
    } else {
      const id = location.pathname.match(/\/chat\/([\w-]+)/)?.[1];
      if (!id) return;
      const [org] = await (await fetch('/api/organizations')).json();
      await fetch(`/api/organizations/${org.uuid}/chat_conversations/${id}`, { method: 'DELETE' });
    }
  } catch (e) {
    console.warn('[ImageTools] delete chat failed', e);
  }
}

async function runJob(job) {
  let error;
  const uploadSizes = new Set(job.steps.flatMap((s) => s.images.map((i) => i.data.length)));
  for (const step of job.steps) {
    try {
      await api(`/agent/jobs/${job.id}/output`, { step: step.index, ...(await (SITE === 'claude' ? textStep : imageStep)(step, uploadSizes)) });
    } catch (e) {
      await api(`/agent/jobs/${job.id}/output`, { step: step.index, error: e.message });
      if (SITE === 'claude' || /limit|try again later/i.test(e.message)) { error = e.message; break; } // no point continuing
    }
  }
  await deleteChat();
  await api(`/agent/jobs/${job.id}/finish`, { error });
}

(async function main() {
  if (window.top !== window) return;
  await sleep(2000);
  for (;;) {
    try {
      if (document.visibilityState !== 'visible') {
        // only the active tab of each window works; extra tabs stay idle
      } else if (!$(SEL.editor)) {
        await api('/agent/status', { state: 'login', note: diagnose() });
      } else if (location.pathname + location.search !== SEL.home && SEL.leave.test(location.pathname)) {
        location.href = SEL.home; // every job starts in a fresh chat
        return;
      } else if (location.pathname + location.search !== SEL.home) {
        // Login, onboarding, settings…: never navigate away from those, just wait.
        await api('/agent/status', { state: 'login', note: `Waiting on ${location.pathname} — finish there or open ${location.origin}${SEL.home}` });
      } else {
        const { job } = await api('/agent/next');
        if (job) {
          await runJob(job);
          location.href = SEL.home;
          return;
        }
      }
    } catch (e) {
      console.warn('[ImageTools]', e);
    }
    await sleep(POLL_MS);
  }
})();
