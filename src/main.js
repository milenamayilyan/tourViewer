import './style.css';
import { PanoramaViewer } from './panorama.js';
import { getMeta, saveMeta, saveProject, loadProject, deleteProject, clearAll, processImage, makeZip } from './store.js';

const base = import.meta.env.BASE_URL;
const $ = (s) => document.querySelector(s);
const app = $('#app');
const D = Math.PI / 180;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n * 10) / 10;
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const maxId = (scenes) => Math.max(0, ...scenes.map((s) => parseInt(s.id.slice(1), 10) || 0));
function slugify(name, taken) {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'land';
  let u = s, i = 2; while (taken.includes(u)) u = `${s}-${i++}`; return u;
}

const viewer = new PanoramaViewer($('#viewer'), { autoSpeed: 3 });
viewer.onLoading = (v) => $('#loader').classList.toggle('show', v);
viewer.onFrame = updateHotspots;

/* project = { slug, name, nextId, tour: { start, scenes: [{ id, name, file, blob?, hotspots: [{ yaw, pitch, label, target }] }] } } */
let projects = [], proj = null, tour = { start: null, scenes: [] };
let meta = { order: [], removed: [], active: null };
let published = null; // { projects: [{ slug, name, cover, count }] }
let currentId = null, busy = false;
let editAllowed = false, editing = false, placing = false;
let hsEls = [], dlg = null, pending = null, labelTouched = false;

const find = (id) => tour.scenes.find((s) => s.id === id);
const sceneUrl = (s, p = proj) => (s.blob ? (s._url ||= URL.createObjectURL(s.blob)) : `${base}tours/${p.slug}/${s.file}`);

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- persistence ---------- */
function serialize(p) {
  const blobs = {};
  const scenes = p.tour.scenes.map((s) => { if (s.blob) blobs[s.id] = s.blob; return { id: s.id, name: s.name, file: s.file, hotspots: s.hotspots }; });
  return { slug: p.slug, name: p.name, nextId: p.nextId, tour: { start: p.tour.start, scenes }, blobs };
}
const revive = (r) => ({ slug: r.slug, name: r.name, nextId: r.nextId || 0,
  tour: { start: r.tour.start, scenes: r.tour.scenes.map((s) => ({ ...s, hotspots: s.hotspots || [], blob: r.blobs?.[s.id] })) } });
const metaNow = () => ({ order: projects.map((p) => p.slug), removed: meta.removed, active: proj?.slug });

let saveTimer;
function persist() {
  if (!editAllowed) return;
  const p = proj;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await saveProject(serialize(p)); await saveMeta(metaNow()); }
    catch { toast('Could not save in this browser'); }
  }, 300);
}
function changed() { persist(); refreshUI(); }

async function fetchJSON(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
}

/* ---------- UI refresh ---------- */
function refreshUI() {
  app.classList.toggle('editing', editing);
  $('#editor').hidden = !editing;
  $('#edit-chip').hidden = !(editAllowed && !editing);
  $('#welcome').hidden = !proj || tour.scenes.length > 0 || !$('#lands').hidden;
  $('#w-title').textContent = editAllowed ? `Start “${proj?.name ?? ''}”` : 'Nothing here yet';
  $('#w-text').textContent = editAllowed
    ? 'Add your 360° photos (equirectangular, 2:1). Then use "Add point" and click the picture to link the views together.'
    : 'Come back soon.';
  $('#w-add').hidden = !editAllowed;
  const sc = find(currentId);
  $('#label-text').textContent = proj ? (sc ? `${proj.name} · ${sc.name}` : proj.name) : '—';
  $('#home').hidden = !(currentId && tour.start && currentId !== tour.start);
  $('#alllands').hidden = editAllowed || !(published && published.projects.length > 1);
  $('#proj-select').innerHTML = projects.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('');
  if (proj) $('#proj-select').value = proj.slug;
  $('#scenes').innerHTML = tour.scenes.map((s) =>
    `<li class="${s.id === currentId ? 'cur' : ''}" data-id="${s.id}"><button class="nm" data-act="open">${s.id === tour.start ? '★ ' : ''}${esc(s.name)}</button><button data-act="start" title="Make this the start view">★</button><button data-act="rename" title="Rename">✎</button><button data-act="del" title="Delete">✕</button></li>`
  ).join('') || '<li class="none">No photos yet</li>';
  renderHotspots();
}

function renderHotspots() {
  const layer = $('#hotspots');
  layer.innerHTML = ''; hsEls = [];
  const s = find(currentId);
  if (!s) return;
  for (const h of s.hotspots) {
    const linked = h.target && find(h.target);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hs' + (linked ? '' : ' static');
    b.innerHTML = `<span class="pin"></span><span class="name">${esc(h.label)}</span>`;
    b.addEventListener('click', () => { if (editing) openDialog(h); else if (linked) show(h.target); });
    layer.appendChild(b);
    hsEls.push({ el: b, h });
  }
}

function updateHotspots() {
  for (const { el, h } of hsEls) {
    const p = viewer.project(h.yaw * D, h.pitch * D);
    el.hidden = !p.visible;
    if (p.visible) el.style.transform = `translate(${p.x - 17}px, ${p.y - 17}px)`;
  }
}

/* ---------- navigation ---------- */
async function show(id) {
  const s = find(id);
  if (!s || busy || id === currentId) return;
  busy = true; app.classList.add('busy');
  try {
    await viewer.goTo(sceneUrl(s));
    currentId = id; refreshUI();
    for (const h of s.hotspots) { const t = find(h.target); if (t && !t.blob) viewer.preload(sceneUrl(t)); }
  } catch { toast(`Could not load "${s.name}"`); }
  finally { busy = false; app.classList.remove('busy'); }
}

/* ---------- projects ---------- */
function blankProject(name) {
  return { slug: slugify(name, projects.map((p) => p.slug)), name, nextId: 0, tour: { start: null, scenes: [] } };
}
async function switchProject(p) {
  if (busy) { refreshUI(); return toast('Please wait a moment…'); }
  setPlacing(false);
  proj = p; tour = p.tour; currentId = null;
  if (!tour.scenes.length) viewer.clear();
  refreshUI(); persist();
  if (tour.scenes.length) await show(find(tour.start) ? tour.start : tour.scenes[0].id);
}
$('#proj-select').addEventListener('change', (e) => switchProject(projects.find((p) => p.slug === e.target.value)));
$('#proj-new').addEventListener('click', () => {
  const n = prompt('Name of the new land', 'New land');
  if (!n || !n.trim()) return;
  meta.removed = meta.removed.filter((x) => x !== slugify(n.trim(), projects.map((p) => p.slug)));
  const p = blankProject(n.trim()); projects.push(p); switchProject(p);
});
$('#proj-rename').addEventListener('click', () => {
  const n = prompt('Rename this land (its link stays the same)', proj.name);
  if (n && n.trim()) { proj.name = n.trim(); changed(); }
});
$('#proj-del').addEventListener('click', async () => {
  if (!confirm(`Delete the land “${proj.name}” and all its views from this browser?`)) return;
  const gone = proj;
  projects = projects.filter((p) => p !== gone);
  if (!meta.removed.includes(gone.slug)) meta.removed.push(gone.slug);
  await deleteProject(gone.slug).catch(() => {});
  if (!projects.length) projects.push(blankProject('My land'));
  proj = null; await switchProject(projects[0]); await saveMeta(metaNow()).catch(() => {});
});
$('#proj-link').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?p=${proj.slug}`;
  try { await navigator.clipboard.writeText(link); toast('Link copied. It works once you have published the tour.', 5000); }
  catch { prompt('Copy this link:', link); }
});
$('#alllands').addEventListener('click', () => { location.href = location.pathname; });

/* ---------- photos ---------- */
async function addScene(file) {
  const blob = await processImage(file);
  const id = 's' + (proj.nextId = Math.max(proj.nextId, maxId(tour.scenes)) + 1);
  const s = { id, name: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || id, file: `images/${id}.jpg`, blob, hotspots: [] };
  tour.scenes.push(s);
  return s;
}

$('#file').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  const p = pending; pending = null;
  if (!files.length) return;
  toast(`Adding ${files.length} photo${files.length > 1 ? 's' : ''}…`, 8000);
  $('#loader').classList.add('show');
  const added = [];
  for (const f of files) { try { added.push(await addScene(f)); } catch { toast(`Could not read ${f.name}`); } }
  $('#loader').classList.remove('show');
  if (!added.length) return;
  toast(`Added ${added.length} photo${added.length > 1 ? 's' : ''}`);
  if (p) {
    const s = added[0], label = p.label || s.name;
    if (p.h) { p.h.label = label; p.h.target = s.id; } else addHotspot(p.pos, label, s.id, true);
  }
  if (!tour.start) tour.start = added[0].id;
  changed();
  if (!currentId) show(added[0].id);
});
$('#ed-add').addEventListener('click', () => { pending = null; $('#file').click(); });
$('#w-add').addEventListener('click', () => { pending = null; $('#file').click(); });

$('#scenes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('li').dataset.id, s = find(id), act = b.dataset.act;
  if (act === 'open') show(id);
  else if (act === 'start') { tour.start = id; changed(); toast(`"${s.name}" is now the start view`); }
  else if (act === 'rename') { const n = prompt('Name for this view', s.name); if (n && n.trim()) { s.name = n.trim(); changed(); } }
  else if (act === 'del' && confirm(`Delete "${s.name}" and the points that lead to it?`)) removeScene(id);
});

function removeScene(id) {
  tour.scenes = tour.scenes.filter((s) => s.id !== id);
  for (const s of tour.scenes) s.hotspots = s.hotspots.filter((h) => h.target !== id);
  if (tour.start === id) tour.start = tour.scenes[0]?.id ?? null;
  if (currentId === id) { currentId = null; if (tour.start) show(tour.start); else viewer.clear(); }
  changed();
}

/* ---------- points ---------- */
function addHotspot(pos, label, target, back) {
  const cur = find(currentId);
  cur.hotspots.push({ yaw: pos.yaw, pitch: pos.pitch, label, target });
  const t = target && find(target);
  if (back && t && !t.hotspots.some((x) => x.target === currentId))
    t.hotspots.push({ yaw: round(wrap(pos.yaw + 180)), pitch: 0, label: cur.name, target: currentId });
}

$('#ed-point').addEventListener('click', () => {
  if (!currentId) return toast('Add a photo first');
  setPlacing(!placing);
  if (placing) toast('Click on the picture where the point should go', 5000);
});
function setPlacing(on) {
  placing = on; app.classList.toggle('placing', on);
  $('#ed-point').textContent = on ? 'Cancel placing' : 'Add point';
}

let down = null;
$('#viewer').addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
$('#viewer').addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
  if (moved > 5 || !placing || !editing) return;
  const p = viewer.pick(e.clientX, e.clientY);
  setPlacing(false);
  openDialog(null, { yaw: round(p.yaw / D), pitch: round(p.pitch / D) });
});

function openDialog(h, pos) {
  dlg = { h, pos }; labelTouched = !!h;
  const others = tour.scenes.filter((s) => s.id !== currentId);
  $('#hs-target').innerHTML = others.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
    + '<option value="__none">Nothing (just a name label)</option><option value="__new">+ A new photo…</option>';
  $('#hs-target').value = h ? (h.target && find(h.target) ? h.target : '__none') : (others[0]?.id ?? '__new');
  $('#hs-label').value = h ? h.label : (others[0]?.name ?? '');
  $('#dlg-title').textContent = h ? 'Edit point' : 'New point';
  $('#hs-delete').hidden = !h;
  $('#hs-go').hidden = !(h && h.target && find(h.target));
  $('#hs-back-wrap').hidden = !!h;
  $('#dialog').hidden = false;
  $('#hs-label').focus();
}
const closeDialog = () => { $('#dialog').hidden = true; dlg = null; };
$('#hs-label').addEventListener('input', () => { labelTouched = true; });
$('#hs-target').addEventListener('change', () => {
  if (labelTouched) return;
  const t = find($('#hs-target').value);
  $('#hs-label').value = t ? t.name : '';
});
$('#hs-cancel').addEventListener('click', closeDialog);
$('#dialog').addEventListener('pointerdown', (e) => { if (e.target.id === 'dialog') closeDialog(); });
$('#hs-delete').addEventListener('click', () => {
  const s = find(currentId); s.hotspots = s.hotspots.filter((x) => x !== dlg.h); closeDialog(); changed();
});
$('#hs-go').addEventListener('click', () => { const t = dlg.h.target; closeDialog(); show(t); });
$('#hs-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#hs-target').value, { h, pos } = dlg;
  let label = $('#hs-label').value.trim();
  if (t === '__new') { pending = { h, pos, label }; closeDialog(); $('#file').click(); return; }
  if (t === '__none' && !label) { $('#hs-label').focus(); return; }
  const target = t === '__none' ? null : t;
  if (!label) label = find(target).name;
  if (h) { h.label = label; h.target = target; }
  else addHotspot(pos, label, target, $('#hs-back').checked);
  closeDialog(); changed();
});

/* ---------- editor buttons ---------- */
$('#ed-preview').addEventListener('click', () => { editing = false; setPlacing(false); refreshUI(); });
$('#edit-chip').addEventListener('click', () => { editing = true; refreshUI(); });
$('#ed-reset').addEventListener('click', async () => {
  if (!confirm('Erase ALL lands and photos stored in this browser and start again? (Published lands are re-loaded from the site.)')) return;
  await clearAll().catch(() => {}); location.reload();
});
$('#ed-export').addEventListener('click', async () => {
  const ready = projects.filter((p) => p.tour.scenes.length);
  if (!ready.length) return toast('Nothing to export yet');
  toast('Preparing tours.zip…', 15000);
  try {
    const files = [], index = { projects: [] };
    for (const p of ready) {
      const start = p.tour.scenes.find((s) => s.id === p.tour.start) || p.tour.scenes[0];
      const json = { start: start.id, scenes: p.tour.scenes.map((s) => ({ id: s.id, name: s.name, file: s.file, hotspots: s.hotspots })) };
      files.push({ name: `tours/${p.slug}/tour.json`, data: new TextEncoder().encode(JSON.stringify(json, null, 2)) });
      for (const s of p.tour.scenes) {
        const buf = s.blob ? await s.blob.arrayBuffer() : await (await fetch(sceneUrl(s, p))).arrayBuffer();
        files.push({ name: `tours/${p.slug}/${s.file}`, data: new Uint8Array(buf) });
      }
      index.projects.push({ slug: p.slug, name: p.name, count: p.tour.scenes.length, cover: `${p.slug}/${start.file}` });
    }
    files.push({ name: 'tours/index.json', data: new TextEncoder().encode(JSON.stringify(index, null, 2)) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(makeZip(files)); a.download = 'tours.zip'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('tours.zip downloaded. Unzip it and upload the "tours" folder into public/ on GitHub.', 9000);
  } catch { toast('Export failed'); }
});

/* ---------- controls ---------- */
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
function syncPlay() {
  const on = viewer.autoRotate, b = $('#play');
  b.innerHTML = (on ? ICON_PAUSE : ICON_PLAY) + `<span>${on ? 'Pause' : 'Play'}</span>`;
  b.setAttribute('aria-label', on ? 'Pause auto-rotation' : 'Play auto-rotation');
}
$('#play').addEventListener('click', () => { viewer.setAutoRotate(!viewer.autoRotate); syncPlay(); });
$('#zoom-in').addEventListener('click', () => viewer.zoom(-10));
$('#zoom-out').addEventListener('click', () => viewer.zoom(10));
$('#home').addEventListener('click', () => show(tour.start));

/* ---------- start ---------- */
const normalize = (j, entry) => ({ slug: entry.slug, name: entry.name, nextId: maxId(j.scenes),
  tour: { start: j.start, scenes: j.scenes.map((s) => ({ ...s, hotspots: s.hotspots || [] })) } });

(async () => {
  const params = new URLSearchParams(location.search);
  published = await fetchJSON(`${base}tours/index.json`);
  if (!published || !Array.isArray(published.projects) || !published.projects.length) published = null;
  editAllowed = params.has('edit') || !published;

  if (editAllowed) {
    meta = { order: [], removed: [], ...(await getMeta().catch(() => null)) };
    for (const slug of meta.order) { const r = await loadProject(slug).catch(() => null); if (r) projects.push(revive(r)); }
    for (const entry of published?.projects ?? []) {
      if (projects.some((p) => p.slug === entry.slug) || meta.removed.includes(entry.slug)) continue;
      const j = await fetchJSON(`${base}tours/${entry.slug}/tour.json`);
      if (j && Array.isArray(j.scenes)) projects.push(normalize(j, entry));
    }
    if (!projects.length) projects.push(blankProject('My first land'));
    proj = projects.find((p) => p.slug === params.get('p')) || projects.find((p) => p.slug === meta.active) || projects[0];
    tour = proj.tour; editing = true;
    Promise.all(projects.map((p) => saveProject(serialize(p)))).then(() => saveMeta(metaNow())).catch(() => {});
  } else {
    const want = params.get('p');
    let entry = published.projects.find((x) => x.slug === want);
    if (!entry && published.projects.length === 1) entry = published.projects[0];
    if (!entry) {
      $('#lands-list').innerHTML = published.projects.map((p) =>
        `<a class="land" href="?p=${encodeURIComponent(p.slug)}" style="background-image:url('${base}tours/${encodeURI(p.cover || '')}')"><span>${esc(p.name)}</span></a>`).join('');
      $('#lands').hidden = false;
      document.title = '360° Tours';
      syncPlay(); refreshUI(); return;
    }
    const j = await fetchJSON(`${base}tours/${entry.slug}/tour.json`);
    if (j && Array.isArray(j.scenes)) { proj = normalize(j, entry); tour = proj.tour; document.title = entry.name; }
  }
  viewer.setAutoRotate(!editing);
  syncPlay(); refreshUI();
  if (tour.scenes.length) show(find(tour.start) ? tour.start : tour.scenes[0].id);
})();
