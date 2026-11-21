const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SITES = { chatgpt: 'ChatGPT', claude: 'Claude' };
const STATE = { ready: ['ok', 'ready'], busy: ['busy', 'working…'], login: ['warn', 'needs login'], offline: ['off', 'offline'] };
const VNC = '/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify';
let tools = [], tool, images = {}, lastJobs = '';

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' } });
  if (r.status === 401) location.reload();
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
};

// Per-browser memory for long text fields (e.g. Claude instructions).
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// Downscale big photos (max 2048px) so uploads stay fast; the AIs don't need more.
const readImage = (file) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('Unsupported image'));
    img.onload = () => {
      const k = Math.min(1, 2048 / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: img.width * k, height: img.height * k });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.92));
    };
    img.src = URL.createObjectURL(file);
  });

function selectTool(t) {
  tool = t;
  images = {};
  $('#tabs').innerHTML = tools.map((x) => `<button type="button" data-id="${x.id}" class="${x === t ? 'on' : ''}">${esc(x.name)}</button>`).join('');
  $('#desc').textContent = t.description;
  $('#inputs').innerHTML = t.inputs.map((i) => `
    <label class="drop" data-key="${i.key}"><input type="file" accept="image/*" ${i.multiple ? 'multiple' : ''} hidden>
      <span>${esc(i.label)}<br><small>click or drop${i.multiple ? ' (one or more)' : ''}</small></span><b class="count"></b></label>`).join('');
  $('#fields').innerHTML = t.fields.map((f) => `<label class="field ${f.type}"><span>${esc(f.label)}</span>${control(f)}</label>`).join('');
  $('#msg').textContent = '';
}

const control = (f) => {
  if (f.type === 'select') return `<select name="${f.key}">${f.options.map((o) => `<option ${o === f.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'multi') return `<div class="chips">${f.options.map((o) => `<label><input type="checkbox" name="${f.key}" value="${esc(o)}" ${f.default?.includes(o) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
  if (f.type === 'textarea') return `<textarea name="${f.key}" rows="6">${esc(store.get(`${tool.id}.${f.key}`) ?? f.default)}</textarea>`;
  return `<input name="${f.key}" placeholder="${esc(f.placeholder)}">`;
};

async function setImages(drop, files) {
  const multiple = tool.inputs.find((i) => i.key === drop.dataset.key).multiple;
  files = [...files].filter((f) => f.type.startsWith('image/')).slice(0, multiple ? 10 : 1);
  if (!files.length) return;
  try {
    const urls = await Promise.all(files.map(readImage));
    images[drop.dataset.key] = multiple ? urls : urls[0];
    drop.style.backgroundImage = `url(${urls[0]})`;
    drop.querySelector('.count').textContent = urls.length > 1 ? urls.length : '';
    drop.classList.add('has');
  } catch (e) {
    $('#msg').textContent = e.message;
  }
}

$('#tabs').onclick = (e) => e.target.dataset.id && selectTool(tools.find((t) => t.id === e.target.dataset.id));
$('#inputs').onchange = (e) => setImages(e.target.closest('.drop'), e.target.files);
$('#inputs').ondragover = (e) => e.preventDefault();
$('#inputs').ondrop = (e) => {
  e.preventDefault();
  const drop = e.target.closest('.drop');
  if (drop) setImages(drop, e.dataTransfer.files);
};

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target), options = {};
  for (const f of tool.fields) {
    options[f.key] = f.type === 'multi' ? fd.getAll(f.key) : fd.get(f.key);
    if (f.type === 'textarea') store.set(`${tool.id}.${f.key}`, options[f.key]);
  }
  $('#go').disabled = true;
  try {
    await api('/api/jobs', { method: 'POST', body: JSON.stringify({ tool: tool.id, images, options }) });
    $('#msg').textContent = '';
    refresh();
  } catch (err) {
    $('#msg').textContent = err.message;
  } finally {
    $('#go').disabled = false;
  }
};

// Bring that site's window to the front of the remote screen, then the link opens it.
$('#agents').onclick = (e) => {
  const site = e.target.closest('[data-site]')?.dataset.site;
  if (site) api('/api/front', { method: 'POST', body: JSON.stringify({ site }) }).catch(() => {});
};

$('#jobs').onclick = async (e) => {
  const { act, id } = e.target.dataset;
  if (!act || (act === 'delete' && !confirm('Delete this job and its images?'))) return;
  await api(`/api/jobs/${id}${act === 'retry' ? '/retry' : ''}`, { method: act === 'retry' ? 'POST' : 'DELETE' });
  refresh();
};

const jobHtml = (j) => {
  const name = tools.find((t) => t.id === j.tool)?.name || j.tool;
  const done = j.outputs.filter((o) => o.file).length;
  const progress = j.status === 'running' || (j.status === 'queued' && j.outputs.length) ? ` ${j.outputs.length}/${j.total}` : '';
  const outputs = j.outputs.filter((o) => !o.text);
  return `<article class="job">
    <div class="row">
      <div class="title"><b>${esc(name)}</b> <span class="badge ${j.status}">${j.status}${progress}</span>
        <small class="muted">${new Date(j.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</small></div>
      ${j.status === 'running' ? '' : `<div class="actions"><button data-act="retry" data-id="${j.id}">Run again</button><button data-act="delete" data-id="${j.id}" class="ghost">Delete</button></div>`}
    </div>
    <div class="ins">${Object.values(j.inputs).flat().map((f) => `<img src="/files/${j.id}/${f}" alt="input">`).join('')}</div>
    <div class="results ${outputs.length ? '' : 'empty'}">
      ${outputs.map((o) => o.file
        ? `<a href="/files/${j.id}/${o.file}" target="_blank" download><img src="/files/${j.id}/${o.file}" alt="result ${o.step + 1}" loading="lazy"></a>`
        : `<div class="fail" title="${esc(o.error)}">✕ ${esc(o.error)}</div>`).join('')}
    </div>
    ${j.outputs.filter((o) => o.text).map((o) => `<details><summary>Claude's prompt</summary><p>${esc(o.text)}</p></details>`).join('')}
    ${j.error && !done ? `<p class="err">${esc(j.error)}</p>` : ''}
  </article>`;
};

async function refresh() {
  const { jobs, agents } = await api('/api/state');
  $('#agents').innerHTML = Object.entries(SITES).map(([site, label]) => {
    const [cls, text] = STATE[agents[site].state] || STATE.offline;
    return `<a class="pill ${cls}" href="${VNC}" target="_blank" data-site="${site}" title="Show ${label} in the server's browser">${label} ${text}</a>`;
  }).join('');
  $('#note').textContent = Object.entries(agents).filter(([, a]) => a.state === 'login').map(([s, a]) => `${SITES[s]}: ${a.note}`).join(' | ');
  const key = JSON.stringify(jobs);
  if (key !== lastJobs) { // re-render only on change so images don't flicker
    lastJobs = key;
    $('#jobs').innerHTML = jobs.map(jobHtml).join('') || '<p class="muted">No jobs yet.</p>';
  }
}

api('/api/state').then((s) => {
  tools = s.tools;
  selectTool(tools[0]);
  refresh();
  setInterval(() => refresh().catch(() => {}), 3000);
});
