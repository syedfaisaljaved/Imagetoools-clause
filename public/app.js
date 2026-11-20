const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const AGENT = {
  ready: ['ok', 'ChatGPT ready'],
  busy: ['busy', 'Generating…'],
  login: ['warn', 'ChatGPT needs login — click to open'],
  offline: ['off', 'Browser offline — click to open'],
};
let tools = [], tool, images = {}, lastJobs = '';

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' } });
  if (r.status === 401) location.reload();
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
};

// Downscale big photos (max 2048px) so uploads stay fast; ChatGPT doesn't need more.
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
    <label class="drop" data-key="${i.key}"><input type="file" accept="image/*" hidden><span>${esc(i.label)}<br><small>click or drop</small></span></label>`).join('');
  $('#fields').innerHTML = t.fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${control(f)}</label>`).join('');
  $('#msg').textContent = '';
}

const control = (f) =>
  f.type === 'select' ? `<select name="${f.key}">${f.options.map((o) => `<option ${o === f.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
  : f.type === 'multi' ? `<div class="chips">${f.options.map((o) => `<label><input type="checkbox" name="${f.key}" value="${esc(o)}" ${f.default?.includes(o) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`
  : `<input name="${f.key}" placeholder="${esc(f.placeholder)}">`;

async function setImage(drop, file) {
  if (!file?.type.startsWith('image/')) return;
  try {
    images[drop.dataset.key] = await readImage(file);
    drop.style.backgroundImage = `url(${images[drop.dataset.key]})`;
    drop.classList.add('has');
  } catch (e) {
    $('#msg').textContent = e.message;
  }
}

$('#tabs').onclick = (e) => e.target.dataset.id && selectTool(tools.find((t) => t.id === e.target.dataset.id));
$('#inputs').onchange = (e) => setImage(e.target.closest('.drop'), e.target.files[0]);
$('#inputs').ondragover = (e) => e.preventDefault();
$('#inputs').ondrop = (e) => {
  e.preventDefault();
  const drop = e.target.closest('.drop');
  if (drop) setImage(drop, e.dataTransfer.files[0]);
};

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target), options = {};
  for (const f of tool.fields) options[f.key] = f.type === 'multi' ? fd.getAll(f.key) : fd.get(f.key);
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

$('#jobs').onclick = async (e) => {
  const { act, id } = e.target.dataset;
  if (!act || (act === 'delete' && !confirm('Delete this job and its images?'))) return;
  await api(`/api/jobs/${id}${act === 'retry' ? '/retry' : ''}`, { method: act === 'retry' ? 'POST' : 'DELETE' });
  refresh();
};

const jobHtml = (j) => {
  const name = tools.find((t) => t.id === j.tool)?.name || j.tool;
  const done = j.outputs.filter((o) => o.file).length;
  const progress = j.status === 'running' ? ` ${j.outputs.length}/${j.total}` : '';
  return `<article class="job">
    <div class="row">
      <b>${esc(name)}</b><span class="badge ${j.status}">${j.status}${progress}</span>
      <small class="muted">${new Date(j.createdAt).toLocaleString()}</small>
      <span class="grow"></span>
      ${j.status === 'running' ? '' : `<button data-act="retry" data-id="${j.id}">Run again</button><button data-act="delete" data-id="${j.id}" class="ghost">Delete</button>`}
    </div>
    <div class="thumbs">
      ${Object.values(j.inputs).map((f) => `<img class="in" src="/files/${j.id}/${f}" alt="input">`).join('')}
      ${j.outputs.map((o) => o.file
        ? `<a href="/files/${j.id}/${o.file}" target="_blank" download><img src="/files/${j.id}/${o.file}" alt="result ${o.step + 1}" loading="lazy"></a>`
        : `<div class="fail" title="${esc(o.error)}">✕ ${esc(o.error)}</div>`).join('')}
    </div>
    ${j.error && !done ? `<p class="err">${esc(j.error)}</p>` : ''}
  </article>`;
};

async function refresh() {
  const { jobs, agent } = await api('/api/state');
  const [cls, label] = AGENT[agent.state] || AGENT.offline;
  $('#agent').className = `pill ${cls}`;
  $('#agent').textContent = label;
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
