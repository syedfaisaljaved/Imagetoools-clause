const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  retry: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
};
const SITES = { chatgpt: 'ChatGPT', claude: 'Claude' };
const DOT = { ready: 'ok', busy: 'busy', login: 'warn' };
const STATE = { ready: 'ready', busy: 'working…', login: 'needs login — tap to open', offline: 'offline — tap to open' };
const VNC = '/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify';
const ADVANCED = (f) => f.type === 'textarea' || f.key === 'notes';
let tools = [], tool, images = {}, lastJobs = '', scrollTo = null;

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' } });
  if (r.status === 401) location.reload();
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
};

// Per-browser memory (last tool, edited Claude instructions). Never required to work.
const mem = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// Downscale big photos (max 2048px) so uploads stay fast; the AIs don't need more.
const readImage = (file) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error(`Can't read ${file.name}`));
    img.onload = () => {
      const k = Math.min(1, 2048 / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: img.width * k, height: img.height * k });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.92));
    };
    img.src = URL.createObjectURL(file);
  });

const showMsg = (text) => { $('#msg').textContent = text || ''; $('#msg').hidden = !text; };

// ---------- Form ----------

function selectTool(t) {
  tool = t;
  images = {};
  mem.set('tool', t.id);
  $('#tabs').innerHTML = tools.map((x) => `<button type="button" role="tab" class="tab" data-id="${x.id}" aria-selected="${x === t}">${esc(x.name)}</button>`).join('');
  $('#desc').textContent = t.description;
  $('#inputs').innerHTML = t.inputs.map((i) => `
    <div class="upload" data-key="${i.key}">
      <span class="upload-label">${esc(i.label)}</span>
      <div class="thumbs"></div>
      <label class="drop">
        <input type="file" accept="image/*" ${i.multiple ? 'multiple' : ''}>
        ${ICON.upload}<strong>${i.multiple ? 'Add photos' : 'Upload photo'}</strong>
        <span class="hint small">Tap to choose${i.multiple ? ' one or more' : ''} · or drop here</span>
      </label>
    </div>`).join('');
  $('#fields').innerHTML = t.fields.filter((f) => !ADVANCED(f)).map(field).join('');
  const adv = t.fields.filter(ADVANCED);
  $('#advfields').innerHTML = adv.map(field).join('');
  $('#advanced').hidden = !adv.length;
  $('#advanced').open = false;
  showMsg('');
}

const field = (f) => {
  if (f.type === 'checkbox') return `<label class="switch"><span>${esc(f.label)}</span><input type="checkbox" role="switch" name="${f.key}"></label>`;
  const control =
    f.type === 'select' ? `<select class="input" name="${f.key}">${f.options.map((o) => `<option ${o === f.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : f.type === 'multi' ? `<div class="chips">${f.options.map((o) => `<label><input type="checkbox" name="${f.key}" value="${esc(o)}" ${f.default?.includes(o) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`
    : f.type === 'textarea' ? `<textarea class="input" name="${f.key}" rows="8">${esc(mem.get(`${tool.id}.${f.key}`) ?? f.default)}</textarea>`
    : `<input class="input" name="${f.key}" placeholder="${esc(f.placeholder)}" autocomplete="off">`;
  return `<label class="field"><span>${esc(f.label)}</span>${control}</label>`;
};

function renderThumbs(key) {
  const box = $(`.upload[data-key="${key}"]`);
  const list = images[key] || [];
  $('.thumbs', box).innerHTML = list.map((url, i) => `<div class="thumb"><img src="${url}" alt=""><button type="button" data-remove="${i}" aria-label="Remove photo">${ICON.x}</button></div>`).join('');
  box.classList.toggle('has', list.length > 0);
  const multiple = tool.inputs.find((i) => i.key === key).multiple;
  $('.drop strong', box).textContent = list.length ? (multiple ? 'Add more' : 'Replace photo') : multiple ? 'Add photos' : 'Upload photo';
}

async function addImages(key, files) {
  const multiple = tool.inputs.find((i) => i.key === key).multiple;
  files = [...files].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  try {
    const urls = await Promise.all(files.map(readImage));
    images[key] = multiple ? [...(images[key] || []), ...urls].slice(0, 10) : urls.slice(0, 1);
    renderThumbs(key);
    showMsg('');
  } catch (e) {
    showMsg(e.message);
  }
}

$('#tabs').onclick = (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && id !== tool.id) selectTool(tools.find((t) => t.id === id));
};
$('#inputs').onchange = (e) => {
  if (e.target.type !== 'file') return;
  addImages(e.target.closest('.upload').dataset.key, e.target.files).then(() => (e.target.value = '')); // allow re-picking the same file
};
$('#inputs').onclick = (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const key = btn.closest('.upload').dataset.key;
  images[key].splice(+btn.dataset.remove, 1);
  renderThumbs(key);
};
$('#inputs').ondragover = (e) => { e.preventDefault(); e.target.closest('.drop')?.classList.add('over'); };
$('#inputs').ondragleave = (e) => e.target.closest('.drop')?.classList.remove('over');
$('#inputs').ondrop = (e) => {
  e.preventDefault();
  $$('.drop.over').forEach((d) => d.classList.remove('over'));
  const up = e.target.closest('.upload');
  if (up) addImages(up.dataset.key, e.dataTransfer.files);
};

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target), options = {};
  for (const f of tool.fields) {
    options[f.key] = f.type === 'multi' ? fd.getAll(f.key) : f.type === 'checkbox' ? fd.has(f.key) : fd.get(f.key);
    if (f.type === 'textarea') mem.set(`${tool.id}.${f.key}`, options[f.key]);
  }
  const payload = Object.fromEntries(tool.inputs.map((i) => [i.key, i.multiple ? images[i.key] || [] : images[i.key]?.[0]]));
  const go = $('#go');
  go.disabled = true;
  go.innerHTML = '<span class="spinner"></span> Adding…';
  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ tool: tool.id, images: payload, options }) });
    showMsg('');
    scrollTo = job.id;
    await refresh();
  } catch (err) {
    showMsg(err.message);
  } finally {
    go.disabled = false;
    go.textContent = 'Generate';
  }
};

// ---------- Status chips ----------

$('#agents').onclick = (e) => {
  const site = e.target.closest('[data-site]')?.dataset.site;
  if (site) api('/api/front', { method: 'POST', body: JSON.stringify({ site }) }).catch(() => {}); // the link then opens the remote screen
};

function renderAgents(agents) {
  $('#agents').innerHTML = Object.entries(SITES).map(([site, label]) => {
    const s = agents[site].state;
    return `<a class="status" href="${VNC}" target="_blank" data-site="${site}" data-state="${s}" title="${label}: ${STATE[s] || s}"><span class="dot ${DOT[s] || ''}"></span>${label}</a>`;
  }).join('');
  const notes = Object.entries(agents).filter(([, a]) => a.state === 'login').map(([s, a]) => `${SITES[s]}: ${a.note}`).join(' · ');
  $('#note').textContent = notes;
  $('#note').hidden = !notes;
}

// ---------- Results ----------

const jobHtml = (j) => {
  const name = tools.find((t) => t.id === j.tool)?.name || j.tool;
  const outs = j.outputs.filter((o) => !o.text);
  const active = j.status === 'running' || j.status === 'queued';
  const pct = Math.round((100 * j.outputs.length) / j.total);
  const when = new Date(j.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  return `<article class="job" id="job-${j.id}">
    <div class="job-head">
      <div class="job-title">
        <b>${esc(name)} <span class="badge ${j.status}">${j.status}${active && j.outputs.length ? ` ${j.outputs.length}/${j.total}` : ''}</span></b>
        <small>${when}</small>
      </div>
      ${j.status === 'running' ? '' : `<div class="job-actions">
        <button class="btn btn-ghost btn-icon" data-act="retry" data-id="${j.id}" title="Run again" aria-label="Run again">${ICON.retry}</button>
        <button class="btn btn-ghost btn-icon" data-act="delete" data-id="${j.id}" title="Delete" aria-label="Delete">${ICON.trash}</button></div>`}
    </div>
    ${active ? `<div class="progress"><i style="width:${Math.max(pct, 4)}%"></i></div>` : ''}
    <div class="ins">${Object.values(j.inputs).flat().map((f) => `<button type="button" data-view="/files/${j.id}/${f}" title="View uploaded image"><img src="/files/${j.id}/${f}" alt="input" loading="lazy"></button>`).join('')}</div>
    ${outs.length ? `<div class="grid">${outs.map((o) => o.file
      ? `<button type="button" data-view="/files/${j.id}/${o.file}"><img src="/files/${j.id}/${o.file}" alt="result ${o.step + 1}" loading="lazy"></button>`
      : `<div class="fail">✕ ${esc(o.error)}</div>`).join('')}</div>` : ''}
    ${j.outputs.filter((o) => o.text).map((o) => `<details><summary>Claude's prompt</summary><p>${esc(o.text)}</p></details>`).join('')}
    ${j.error && !outs.some((o) => o.file) ? `<p class="alert">${esc(j.error)}</p>` : ''}
  </article>`;
};

$('#jobs').onclick = async (e) => {
  const view = e.target.closest('[data-view]')?.dataset.view;
  if (view) return openViewer(view);
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'delete' && !confirm('Delete this job and its images?')) return;
  await api(`/api/jobs/${id}${act === 'retry' ? '/retry' : ''}`, { method: act === 'retry' ? 'POST' : 'DELETE' });
  refresh();
};

function openViewer(src) {
  $('#viewer-img').src = src;
  $('#viewer-dl').href = src;
  $('#viewer-tools').innerHTML = tools.map((t) => `<button type="button" data-use="${t.id}">${esc(t.name)}</button>`).join('');
  $('#viewer').showModal();
}
$('#viewer').onclick = (e) => {
  const use = e.target.closest('[data-use]')?.dataset.use;
  if (use) return useImage($('#viewer-img').getAttribute('src'), use);
  if (e.target.matches('[data-close], #viewer, #viewer-img')) $('#viewer').close();
};

// Loads a result (or uploaded) image into another tool's first photo slot, ready to Generate.
async function useImage(src, toolId) {
  $('#viewer').close();
  selectTool(tools.find((t) => t.id === toolId));
  const blob = await (await fetch(src)).blob();
  await addImages(tool.inputs[0].key, [new File([blob], src.split('/').pop(), { type: blob.type })]);
  $('#form').scrollIntoView({ behavior: 'smooth' });
}

async function refresh() {
  const { jobs, agents } = await api('/api/state');
  renderAgents(agents);
  const key = JSON.stringify(jobs);
  if (key !== lastJobs) { // re-render only on change so images don't flicker
    lastJobs = key;
    $('#jobs').innerHTML = jobs.map(jobHtml).join('') || '<p class="empty muted">Your generated images will appear here.</p>';
  }
  if (scrollTo && innerWidth < 900) document.getElementById(`job-${scrollTo}`)?.scrollIntoView({ behavior: 'smooth' });
  scrollTo = null;
}

api('/api/state').then((s) => {
  tools = s.tools;
  selectTool(tools.find((t) => t.id === mem.get('tool')) || tools[0]);
  refresh();
  setInterval(() => refresh().catch(() => {}), 3000);
});
