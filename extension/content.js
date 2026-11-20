// Runs inside the chatgpt.com tab: polls the server for jobs and performs each step like a user would.
// If ChatGPT changes its page, only SEL usually needs updating.
const SEL = {
  editor: '#prompt-textarea',
  fileInput: 'input[type="file"]',
  send: '[data-testid="send-button"], #composer-submit-button',
  stop: '[data-testid="stop-button"]',
  user: '[data-message-author-role="user"]',
  assistant: '[data-message-author-role="assistant"]',
};
const POLL_MS = 3000;
const STEP_TIMEOUT = 8 * 60e3; // image generation can be slow on busy hours

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, body) {
  const r = await chrome.runtime.sendMessage({ path, body });
  if (r?.error) throw new Error(r.error);
  return r;
}

async function waitFor(fn, timeout, every = 500) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(every)) {
    const v = fn();
    if (v) return v;
  }
  return null;
}

// Images produced by ChatGPT (not the ones we uploaded, not avatars/icons).
const resultImages = () =>
  $$('main img').filter((img) => !img.closest(SEL.user) && (/generated image/i.test(img.alt) || img.naturalWidth >= 400));

const lastReply = () => $$(SEL.assistant).at(-1)?.innerText.trim().slice(0, 400) || '';

function attach(images) {
  const dt = new DataTransfer();
  for (const { name, type, data } of images) dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type }));
  const input = $(SEL.fileInput);
  if (!input) throw new Error('Upload button not found');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function submit(text) {
  const editor = $(SEL.editor);
  editor.focus();
  document.execCommand('selectAll');
  document.execCommand('insertText', false, text);
  // Send stays disabled while uploads are in progress.
  const btn = await waitFor(() => { const b = $(SEL.send); return b && !b.disabled && b; }, 120e3);
  if (!btn) throw new Error('Send button never became ready (upload failed?)');
  btn.click();
  await waitFor(() => $(SEL.stop), 15e3); // generation started (may be too quick to catch — fine)
  if (!(await waitFor(() => !$(SEL.stop), STEP_TIMEOUT, 1000))) throw new Error('Timed out waiting for ChatGPT');
}

// Waits for a new result image whose src stops changing (progressive previews settle into the final image).
// Gives up after 45s if no new image appeared at all (image tool may start after the text reply).
async function newImage(before) {
  const start = Date.now();
  let last, stable = 0;
  return waitFor(() => {
    const cur = resultImages().filter((i) => !before.has(i.src)).at(-1);
    if (!cur && Date.now() - start > 45e3) return 'none';
    if (cur?.complete && cur.naturalWidth && cur.src === last) return ++stable >= 3 && cur;
    last = cur?.src;
    stable = 0;
  }, 120e3, 1000).then((r) => (r === 'none' ? null : r));
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

async function runStep(step) {
  const before = new Set(resultImages().map((i) => i.src));
  if (step.images.length) attach(step.images);
  await submit(step.prompt);
  let img = await newImage(before);
  if (!img && !/limit|try again|can't|cannot|unable/i.test(lastReply())) {
    await submit('Yes — generate the image now exactly as described.'); // ChatGPT sometimes asks for confirmation
    img = await newImage(before);
  }
  if (!img) throw new Error(lastReply() || 'No image was generated');
  return toBase64(img.src);
}

async function runJob(job) {
  let error;
  for (const [i, step] of job.steps.entries()) {
    try {
      await api(`/agent/jobs/${job.id}/output`, { step: i, image: await runStep(step) });
    } catch (e) {
      await api(`/agent/jobs/${job.id}/output`, { step: i, error: e.message });
      if (/limit|try again later/i.test(e.message)) { error = e.message; break; } // quota hit: stop wasting time
    }
  }
  await api(`/agent/jobs/${job.id}/finish`, { error });
}

(async function main() {
  if (window.top !== window) return;
  await sleep(2000);
  for (;;) {
    try {
      if (!$(SEL.editor)) {
        await api('/agent/status', { state: 'login', note: 'ChatGPT needs attention: log in or complete the check in the remote browser.' });
      } else if (location.pathname !== '/') {
        location.href = '/'; // every job starts in a fresh chat
        return;
      } else {
        const { job } = await api('/agent/next');
        if (job) {
          await runJob(job);
          location.href = '/';
          return;
        }
      }
    } catch (e) {
      console.warn('[ImageTools]', e);
    }
    await sleep(POLL_MS);
  }
})();
