// =====================================================================
// Mesa de control. Funciona con cualquier "adaptador" de almacenamiento:
//   - adapter-netlify.js  (sitio en Netlify, API + contraseña)
//   - adaptador interno   (mesa de control publicada en Claude)
// Interfaz del adaptador:
//   init() -> {needLogin} | {role, state}
//   login(pw) -> {role, state};  logout()
//   save(state, baseVersion) -> state   (error.state si hubo conflicto)
//   score(matchId, payload, knownUpdatedAt) -> {state, conflict}
//   undo(logId) -> state;  demo() -> state;  reload() -> state
//   history?() -> [{key, version, updatedAt, last}];  restore?(key) -> state
//   watch(cb)   (avisa cuando otro usuario guardó)
//   canLogout, publicUrl, label
// =====================================================================
import { Engine as E } from './engine.js';
import {
  esc, $, $$, ctx, matchRow, matchesByDay, standingsTable, bracketHtml, podiumHtml,
  fmtTime, fmtDay, fmtDayLong, parseLocal, applyTheme, toast,
} from './ui.js';

let A = null; // adaptador
let S = null; // estado completo
let ROLE = null;
let C = null;
let VIEW = 'panel';
let SUB = {}; // estado de UI por vista
let modalOpen = false;
let root = null;

const isAdmin = () => ROLE === 'admin';
const canEdit = () => ROLE === 'admin' || ROLE === 'scorer';

export async function startAdmin(adapter, mount) {
  A = adapter;
  root = mount;
  root.innerHTML = '<div class="empty"><b>Cargando mesa de control…</b></div>';
  try {
    const r = await A.init();
    if (r.needLogin) return renderLogin();
    setState(r.state, r.role);
  } catch (e) {
    root.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    return;
  }
  A.watch?.(async (newState) => {
    if (!S || newState.version === S.version) return;
    if (modalOpen) { pendingRemote = newState; return; }
    setState(newState, ROLE, true);
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.replace('#', '');
    if (v && v !== VIEW && NAV.some((n) => n[0] === v)) { VIEW = v; render(); }
  });
}
let pendingRemote = null;

function setState(state, role, silent) {
  S = state;
  ROLE = role;
  C = ctx(S);
  applyTheme(S.tournament);
  if (!isAdmin() && !['partidos', 'panel'].includes(VIEW)) VIEW = 'partidos';
  render();
  if (silent) flashSync();
}
function flashSync() {
  const el = $('#syncInfo');
  if (el) el.textContent = `Sincronizado ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// Guarda un cambio hecho sobre una copia del estado
async function commit(mutator, okMsg) {
  if (!isAdmin()) { toast('Solo la mesa de control (admin) puede hacer esto.', true); return false; }
  const draft = E.clone(S);
  try {
    mutator(draft);
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  try {
    const saved = await A.save(draft, S.version);
    setState(saved, ROLE);
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    return handleErr(e);
  }
}
function handleErr(e) {
  if (e.status === 401) { toast('Tu sesión expiró. Vuelve a entrar.', true); renderLogin(); return false; }
  if (e.state) setState(e.state, ROLE);
  toast(e.message || 'Error', true, 5000);
  return false;
}

async function sendScore(matchId, payload) {
  const m = S.matches.find((x) => x.id === matchId);
  try {
    const r = await A.score(matchId, payload, m?.updatedAt || null);
    setState(r.state, ROLE);
    toast(r.conflict ? '⚠️ Guardado, pero alguien más había modificado este partido. Revisa.' : 'Guardado ✓', !!r.conflict);
    return true;
  } catch (e) {
    return handleErr(e);
  }
}

// =====================================================================
// Login
// =====================================================================
function renderLogin() {
  root.innerHTML = `<div class="login"><div class="card">
    <h2 style="margin-bottom:6px">Mesa de control</h2><p class="muted small">Acceso solo para organizadores.</p>
    <form id="lf"><div class="field"><label>Contraseña</label><input type="password" id="pw" autocomplete="current-password" required></div>
    <div id="lerr"></div><button class="btn lg" style="width:100%">Entrar</button></form>
    <p class="small muted" style="margin-top:14px"><a href="/">← Volver al sitio</a></p></div></div>`;
  $('#pw').focus();
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await A.login($('#pw').value);
      setState(r.state, r.role);
    } catch (ex) {
      $('#lerr').innerHTML = `<div class="alert">${esc(ex.message)}</div>`;
    }
  });
}

// =====================================================================
// Estructura
// =====================================================================
const NAV = [
  ['panel', '📊', 'Panel'],
  ['partidos', '🎾', 'Resultados'],
  ['calendario', '🗓️', 'Calendario'],
  ['grupos', '🧩', 'Grupos'],
  ['llaves', '🏆', 'Llaves'],
  ['inscripciones', '📝', 'Inscripciones'],
  ['categorias', '⚙️', 'Categorías y reglas'],
  ['torneo', '🏟️', 'Torneo y pistas'],
  ['historial', '🕘', 'Historial y respaldo'],
];

function render() {
  if (!S) return;
  const pending = S.teams.filter((t) => t.status === 'pending').length;
  const nav = NAV.filter(([k]) => isAdmin() || ['panel', 'partidos'].includes(k));
  const t = S.tournament;
  document.body.classList.toggle('no-print-btn', !!A.noPrint);
  root.innerHTML = `
  <header class="topbar"><div class="wrap">
    <span class="brand">${t.logoUrl ? `<img src="${esc(t.logoUrl)}" alt="">` : '<span class="dot"></span>'}<span class="t">${esc(t.name)}</span></span>
    <span class="chip" style="background:rgba(255,255,255,.12);color:#fff">${isAdmin() ? 'Mesa de control' : ROLE === 'scorer' ? 'Capturista' : 'Solo lectura'}${A.label ? ' · ' + esc(A.label) : ''}</span>
    <div class="spacer"></div>
    <span class="small no-print" id="syncInfo" style="opacity:.75"></span>
    ${A.publicUrl ? `<a class="btn accent sm" href="${A.publicUrl}" target="_blank" rel="noopener">Ver sitio</a>` : ''}
    ${A.canLogout ? '<button class="btn ghost sm" id="logout">Salir</button>' : ''}
  </div></header>
  ${t.announcement ? `<div class="banner"><div class="wrap"><span>📣</span><span>${esc(t.announcement)}</span></div></div>` : ''}
  <main><div class="wrap admin-layout">
    <nav class="sidenav no-print">${nav.map(([k, ic, l]) => `<button data-v="${k}" class="${k === VIEW ? 'active' : ''}"><span>${ic}</span>${l}${k === 'inscripciones' && pending ? `<span class="badge">${pending}</span>` : ''}</button>`).join('')}</nav>
    <section id="view"></section>
  </div></main>`;
  $$('.sidenav button').forEach((b) => b.addEventListener('click', () => { VIEW = b.dataset.v; history.replaceState(null, '', '#' + VIEW); render(); window.scrollTo(0, 0); }));
  $('#logout')?.addEventListener('click', async () => { await A.logout(); location.reload(); });
  flashSync();
  const views = { panel: vPanel, partidos: vPartidos, calendario: vCalendario, grupos: vGrupos, llaves: vLlaves, inscripciones: vInscripciones, categorias: vCategorias, torneo: vTorneo, historial: vHistorial };
  (views[VIEW] || vPanel)($('#view'));
}

// ---------- Modal ----------
function modal(title, bodyHtml, { wide = false, foot = '' } = {}) {
  closeModal();
  modalOpen = true;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'ov';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="modal-head"><h3>${title}</h3><button class="x" id="mx" aria-label="Cerrar">×</button></div><div class="modal-body">${bodyHtml}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  $('#mx').addEventListener('click', closeModal);
  return ov;
}
function closeModal() {
  $('#ov')?.remove();
  modalOpen = false;
  if (pendingRemote) { const s = pendingRemote; pendingRemote = null; if (s.version !== S.version) setState(s, ROLE, true); }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen) closeModal(); });

function confirmBox(msg, okLabel = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    modal('Confirmar', `<p>${msg}</p>`, { foot: `<button class="btn ghost" id="cno">Cancelar</button><button class="btn ${danger ? 'danger' : ''}" id="cyes">${okLabel}</button>` });
    $('#cno').onclick = () => { closeModal(); resolve(false); };
    $('#cyes').onclick = () => { closeModal(); resolve(true); };
  });
}

const catOptions = (cur, all = true) =>
  (all ? `<option value="">Todas las categorías</option>` : '') + S.categories.map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const courtOptions = (cur) => `<option value="">Sin pista</option>` + S.courts.map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (inactiva)'}</option>`).join('');

// =====================================================================
// PANEL
// =====================================================================
function vPanel(el) {
  const now = new Date();
  const live = S.matches.filter((m) => m.status === 'playing' || m.status === 'called');
  const late = S.matches.filter((m) => m.status === 'scheduled' && m.time && m.teamA && m.teamB && parseLocal(m.time) < new Date(now - 10 * 60000));
  const next = S.matches.filter((m) => m.status === 'scheduled' && m.time && parseLocal(m.time) >= new Date(now - 10 * 60000)).sort((a, b) => a.time.localeCompare(b.time)).slice(0, 8);
  const confirmed = S.teams.filter((t) => t.status === 'confirmed').length;
  const pend = S.teams.filter((t) => t.status === 'pending').length;
  const unpaid = S.teams.filter((t) => t.status !== 'withdrawn' && t.paid !== 'paid').length;
  const playable = S.matches.filter((m) => m.status !== 'bye' && m.status !== 'cancelled');
  const done = playable.filter((m) => E.isDone(m)).length;
  el.innerHTML = `
  ${ROLE === 'scorer' ? '<div class="readonly-note">Modo capturista: puedes registrar marcadores y estados de partido.</div>' : ''}
  ${ROLE === 'viewer' ? '<div class="readonly-note">Modo solo lectura: pide al organizador acceso de edición para capturar resultados.</div>' : ''}
  <div class="section-head"><h2>Panel del torneo</h2>${isAdmin() ? '<button class="btn ghost sm" id="annBtn">📣 Aviso en el sitio</button>' : ''}</div>
  <div class="kpis">
    <div class="kpi"><b>${live.filter((m) => m.status === 'playing').length}</b><span>En juego</span></div>
    <div class="kpi"><b style="color:${late.length ? 'var(--danger)' : ''}">${late.length}</b><span>Retrasados</span></div>
    <div class="kpi"><b>${done}/${playable.length}</b><span>Partidos jugados</span></div>
    <div class="kpi"><b>${confirmed}</b><span>Parejas confirmadas</span></div>
    ${isAdmin() ? `<div class="kpi"><b>${pend}</b><span>Inscripciones por revisar</span></div><div class="kpi"><b>${unpaid}</b><span>Pagos pendientes</span></div>` : ''}
  </div>
  ${live.length ? `<div class="section"><h3 style="margin-bottom:8px">En pista ahora</h3><div class="card list">${live.map((m) => rowWithActions(m)).join('')}</div></div>` : ''}
  ${late.length ? `<div class="section"><h3 style="margin-bottom:8px;color:var(--danger)">Retrasados (más de 10 min)</h3><div class="card list">${late.map((m) => rowWithActions(m)).join('')}</div></div>` : ''}
  <div class="section"><h3 style="margin-bottom:8px">Próximos</h3>${next.length ? `<div class="card list">${next.map((m) => rowWithActions(m)).join('')}</div>` : '<div class="card empty">No hay partidos programados próximamente.</div>'}</div>
  <div class="section"><h3 style="margin-bottom:8px">Avance por categoría</h3><div class="grid grid-3">${S.categories
    .map((c) => {
      const ms = S.matches.filter((m) => m.categoryId === c.id && m.status !== 'bye' && m.status !== 'cancelled');
      const d = ms.filter((m) => E.isDone(m)).length;
      const pct = ms.length ? Math.round((d / ms.length) * 100) : 0;
      return `<div class="card"><div class="row"><b>${esc(c.name)}</b><span class="spacer"></span><span class="chip">${esc(CAT_STATUS[c.status])}</span></div>
      <div class="small muted" style="margin:6px 0">${E.activeTeams(S, c.id).length} parejas · ${d}/${ms.length} partidos</div><div class="progress"><div style="width:${pct}%"></div></div>
      <div class="row small" style="margin-top:8px">${c.publish.groups ? '<span class="chip ok">Grupos públicos</span>' : '<span class="chip">Grupos ocultos</span>'}${c.publish.ko ? '<span class="chip ok">Llave pública</span>' : '<span class="chip">Llave oculta</span>'}</div></div>`;
    })
    .join('') || '<div class="card empty">Crea tu primera categoría en “Categorías y reglas”.</div>'}</div></div>`;
  bindRowActions(el);
  $('#annBtn')?.addEventListener('click', () => {
    modal('Aviso en el sitio público', `<div class="field"><label>Mensaje (vacío = sin aviso)</label><textarea id="annT" maxlength="200">${esc(S.tournament.announcement)}</textarea></div><div class="seg">${['Retraso de 20 min en todas las pistas', 'Pausa por lluvia', 'Siguiente ronda en 15 min'].map((x) => `<button type="button" data-t="${esc(x)}">${esc(x)}</button>`).join('')}</div>`, { foot: '<button class="btn" id="annSave">Publicar aviso</button>' });
    $$('.seg button').forEach((b) => (b.onclick = () => ($('#annT').value = b.dataset.t)));
    $('#annSave').onclick = async () => { const v = $('#annT').value.trim(); closeModal(); await commit((d) => { d.tournament.announcement = v; }, v ? 'Aviso publicado' : 'Aviso retirado'); };
  });
}
const CAT_STATUS = { registration: 'Inscripciones', groups: 'Fase de grupos', knockout: 'Eliminatorias', finished: 'Finalizada' };

function rowWithActions(m) {
  const done = E.isDone(m);
  const ready = m.teamA && m.teamB;
  let qa = '';
  if (ready && !done && canEdit()) {
    qa = `<div class="qa no-print">${m.status === 'scheduled' ? `<button class="btn ghost sm" data-q="called" data-id="${m.id}">Llamar</button>` : ''}${m.status !== 'playing' ? `<button class="btn ghost sm" data-q="playing" data-id="${m.id}">En juego</button>` : ''}<button class="btn sm" data-q="score" data-id="${m.id}">Resultado</button></div>`;
  } else if (canEdit() && m.status !== 'bye') qa = `<div class="qa no-print"><button class="btn ghost sm" data-q="score" data-id="${m.id}">${done ? 'Editar' : 'Detalles'}</button></div>`;
  return matchRow(C, m, { action: qa });
}
function bindRowActions(el) {
  $$('[data-q]', el).forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      if (b.dataset.q === 'score') openScore(id);
      else sendScore(id, { status: b.dataset.q, clearResult: false });
    })
  );
}

// =====================================================================
// RESULTADOS (captura rápida)
// =====================================================================
function vPartidos(el) {
  const f = (SUB.partidos ||= { cat: '', court: '', status: 'open', q: '', day: '' });
  const days = [...new Set(S.matches.filter((m) => m.time).map((m) => m.time.slice(0, 10)))].sort();
  el.innerHTML = `<div class="section-head"><h2>Captura de resultados</h2><span class="muted small">Toca “Resultado” para registrar el marcador</span></div>
  <div class="row no-print" style="margin-bottom:10px">
    <input type="search" id="pq" placeholder="Buscar jugador…" value="${esc(f.q)}" style="max-width:220px">
    <select id="pcat" style="max-width:190px">${catOptions(f.cat)}</select>
    <select id="pcourt" style="max-width:150px"><option value="">Todas las pistas</option>${S.courts.map((c) => `<option value="${c.id}" ${c.id === f.court ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <select id="pday" style="max-width:160px"><option value="">Todos los días</option>${days.map((d) => `<option value="${d}" ${d === f.day ? 'selected' : ''}>${fmtDay(d + 'T00:00')}</option>`).join('')}</select>
    <div class="seg" id="pst">${[['open', 'Pendientes'], ['live', 'En pista'], ['done', 'Jugados'], ['all', 'Todos']].map(([k, l]) => `<button data-k="${k}" class="${f.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  </div><div id="plist"></div>`;
  const draw = () => {
    let ms = S.matches.filter((m) => m.status !== 'bye');
    if (f.cat) ms = ms.filter((m) => m.categoryId === f.cat);
    if (f.court) ms = ms.filter((m) => m.court === f.court);
    if (f.day) ms = ms.filter((m) => m.time && m.time.startsWith(f.day));
    if (f.status === 'open') ms = ms.filter((m) => !E.isDone(m) && m.status !== 'cancelled');
    if (f.status === 'live') ms = ms.filter((m) => m.status === 'playing' || m.status === 'called');
    if (f.status === 'done') ms = ms.filter((m) => E.isDone(m));
    const q = E.norm(f.q);
    if (q.length >= 2) ms = ms.filter((m) => E.norm(C.tname(m.teamA, '') + ' ' + C.tname(m.teamB, '')).includes(q));
    const sorted = ms.sort((a, b) => (a.time || '9999').localeCompare(b.time || '9999'));
    if (!sorted.length) { $('#plist').innerHTML = '<div class="card empty"><b>Nada por aquí</b>Cambia los filtros.</div>'; return; }
    let html = '';
    let day = null;
    for (const m of sorted) {
      const d = m.time ? m.time.slice(0, 10) : 'none';
      if (d !== day) { if (day !== null) html += '</div>'; html += `<div class="card list section"><div class="daybar">${m.time ? fmtDay(m.time) : 'Sin horario'}</div>`; day = d; }
      html += rowWithActions(m);
    }
    $('#plist').innerHTML = html + '</div>';
    bindRowActions($('#plist'));
  };
  $('#pq').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  $('#pcat').addEventListener('change', (e) => { f.cat = e.target.value; draw(); });
  $('#pcourt').addEventListener('change', (e) => { f.court = e.target.value; draw(); });
  $('#pday').addEventListener('change', (e) => { f.day = e.target.value; draw(); });
  $$('#pst button').forEach((b) => b.addEventListener('click', () => { f.status = b.dataset.k; $$('#pst button').forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
  draw();
}

// ---------- Modal de marcador ----------
function openScore(matchId) {
  const m = S.matches.find((x) => x.id === matchId);
  if (!m) return;
  const fmt = E.formatFor(S, m);
  const nSets = fmt.type === 'oneSet' ? 1 : 3;
  const sets = Array.from({ length: nSets }, (_, i) => (m.sets && m.sets[i] ? m.sets[i].slice() : ['', '']));
  let status = E.isDone(m) ? m.status : 'finished';
  let winner = m.winner || null;
  const ready = m.teamA && m.teamB;
  const nA = C.tname(m.teamA);
  const nB = C.tname(m.teamB);
  const stepper = (i, side) => `<div class="stepper"><button type="button" data-st="${i}|${side}|-1">−</button><input type="number" inputmode="numeric" min="0" max="30" data-set="${i}|${side}" value="${sets[i][side === 'A' ? 0 : 1]}"><button type="button" data-st="${i}|${side}|1">+</button></div>`;
  const body = `
    <div class="small muted" style="margin-bottom:10px">${esc(C.cat(m.categoryId)?.name || '')} · ${esc(C.stageLabel(m))} · ${esc(E.formatLabel(fmt))}</div>
    ${ready ? '' : '<div class="alert info">Aún no se conocen las dos parejas. Puedes asignar pista y horario.</div>'}
    <div class="field"><label>Estado</label><div class="seg" id="sst">${[['finished', 'Final'], ['walkover', 'W.O.'], ['retired', 'Retiro'], ['playing', 'En juego'], ['called', 'Llamado'], ['scheduled', 'Programado'], ['postponed', 'Pospuesto'], ['cancelled', 'Cancelado']].map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}</div></div>
    <div id="scoreBox">
      <div class="score-grid"><div></div><div class="hd tn">${esc(nA)}</div><div class="hd tn">${esc(nB)}</div>
        ${Array.from({ length: nSets }, (_, i) => `<div class="hd">${fmt.type !== 'oneSet' && i === 2 && fmt.superTB ? 'Súper TB' : nSets === 1 ? 'Set' : 'Set ' + (i + 1)}</div>${stepper(i, 'A')}${stepper(i, 'B')}`).join('')}
      </div>
      <div class="small muted" style="margin-top:6px" id="sHint"></div>
    </div>
    <div class="field" id="winBox" style="margin-top:12px"><label>¿Quién gana?</label><div class="seg" id="swin"><button type="button" data-w="A">${esc(nA)}</button><button type="button" data-w="B">${esc(nB)}</button></div></div>
    ${isAdmin() ? `<div class="form-grid" style="margin-top:12px"><div class="field"><label>Pista</label><select id="scourt">${courtOptions(m.court)}</select></div><div class="field"><label>Fecha y hora</label><input type="datetime-local" id="stime" value="${esc(m.time || '')}"></div></div>` : ''}
    <div class="field"><label>Nota (visible en el sitio)</label><input type="text" id="snote" maxlength="80" value="${esc(m.note || '')}" placeholder="Ej. cambio de pista"></div>
    <div id="serr"></div>
    ${m.updatedAt ? `<p class="small muted">Última modificación: ${new Date(m.updatedAt).toLocaleString('es-MX')} por ${esc(m.updatedBy || '')}</p>` : ''}`;
  modal(`${esc(nA)} <span class="muted">vs</span> ${esc(nB)}`, body, { foot: '<button class="btn ghost" id="scancel">Cancelar</button><button class="btn lg" id="ssave">Guardar</button>' });
  const sync = () => {
    $$('#sst button').forEach((b) => b.classList.toggle('on', b.dataset.k === status));
    const scoreVisible = ['finished', 'retired', 'playing'].includes(status);
    $('#scoreBox').classList.toggle('hidden', !scoreVisible || !ready);
    $('#winBox').classList.toggle('hidden', !['walkover', 'retired'].includes(status));
    $$('#swin button').forEach((b) => b.classList.toggle('on', b.dataset.w === winner));
    $('#sHint').textContent = status === 'playing' ? 'Marcador parcial (opcional): se muestra en vivo.' : status === 'retired' ? 'Captura el marcador al momento del retiro.' : '';
  };
  $$('#sst button').forEach((b) => (b.onclick = () => { status = b.dataset.k; sync(); }));
  $$('#swin button').forEach((b) => (b.onclick = () => { winner = b.dataset.w; sync(); }));
  $$('[data-st]').forEach((b) =>
    (b.onclick = () => {
      const [i, side, d] = b.dataset.st.split('|');
      const inp = $(`[data-set="${i}|${side}"]`);
      inp.value = Math.max(0, Math.min(30, (Number(inp.value) || 0) + Number(d)));
    })
  );
  $('#scancel').onclick = closeModal;
  $('#ssave').onclick = async () => {
    const read = [];
    for (let i = 0; i < nSets; i++) {
      const a = $(`[data-set="${i}|A"]`).value;
      const b = $(`[data-set="${i}|B"]`).value;
      if (a === '' && b === '') continue;
      read.push([Number(a) || 0, Number(b) || 0]);
    }
    const payload = { status, note: $('#snote').value.trim() };
    if (['finished', 'retired', 'playing'].includes(status)) payload.sets = read;
    if (['walkover', 'retired'].includes(status)) payload.winner = winner;
    if (isAdmin()) { payload.court = $('#scourt').value || null; payload.time = $('#stime').value || null; }
    if (status === 'finished') {
      try { E.validateScore(read, fmt); } catch (e) { $('#serr').innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
    }
    if (['walkover', 'retired'].includes(status) && !winner) { $('#serr').innerHTML = '<div class="alert">Selecciona qué pareja gana.</div>'; return; }
    if (E.isDone(m) && !['finished', 'walkover', 'retired'].includes(status) && !(await confirmBox('Esto borrará el resultado ya capturado. ¿Continuar?', 'Sí, borrar resultado', true))) return;
    $('#ssave').disabled = true;
    const ok = await sendScore(matchId, payload);
    if (ok) closeModal();
    else if ($('#ssave')) $('#ssave').disabled = false;
  };
  sync();
}

// =====================================================================
// CALENDARIO
// =====================================================================
function vCalendario(el) {
  const sch = S.schedule;
  const days = sch.days.map((d) => d.date);
  const f = (SUB.cal ||= { day: days[0] || '' });
  if (!days.includes(f.day)) f.day = days[0] || '';
  const courts = S.courts.filter((c) => c.active);
  const dur = Number(sch.slotMinutes) || 75;
  const day = sch.days.find((d) => d.date === f.day);
  const slots = [];
  if (day) for (let t = toMin(day.start); t + dur <= toMin(day.end); t += dur) slots.push(`${day.date}T${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  const conflicts = findConflicts();
  const card = (m) => `<div class="smatch ${E.isDone(m) ? 'done' : ''} ${m.status === 'playing' ? 'live' : ''} ${conflicts.has(m.id) ? 'conflict' : ''}" draggable="true" data-m="${m.id}" title="${conflicts.has(m.id) ? 'Choque: un jugador tiene otro partido sin descanso suficiente' : ''}"><div class="c">${esc(C.cat(m.categoryId)?.name || '')} · ${esc(C.stageLabel(m))}</div>${esc(C.tname(m.teamA, '¿?'))}<br>${esc(C.tname(m.teamB, '¿?'))}</div>`;
  const inSlot = (slot, courtId) => S.matches.filter((m) => m.court === courtId && m.time && slotOf(m.time, day, dur) === slot);
  const unscheduled = S.matches.filter((m) => !m.time && !E.isDone(m) && m.status !== 'cancelled');
  el.innerHTML = `<div class="section-head"><h2>Calendario</h2><div class="row no-print">
      <button class="btn" id="autoBtn">⚡ Programar automáticamente</button><button class="btn ghost printbtn" id="printBtn">🖨️ Imprimir</button></div></div>
    ${!sch.days.length ? '<div class="alert info">Primero configura los días de juego en “Torneo y pistas”.</div>' : ''}
    <div class="row no-print" style="margin-bottom:10px"><div class="seg">${days.map((d) => `<button data-d="${d}" class="${d === f.day ? 'on' : ''}">${fmtDay(d + 'T00:00')}</button>`).join('')}</div>
      <span class="small muted">Arrastra los partidos entre celdas. Si sueltas sobre otro partido, se intercambian. Los bordes rojos indican choques de horario.</span></div>
    ${unscheduled.length ? `<div class="card section"><h3 style="margin-bottom:8px">Por programar (${unscheduled.length})</h3><div class="unsched" data-cell="none">${unscheduled.map(card).join('')}</div></div>` : ''}
    <div class="card section sched"><h3 style="margin-bottom:6px">${day ? esc(fmtDayLong(day.date)) : ''}</h3><table><thead><tr><th></th>${courts.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
      ${slots.map((s) => `<tr><td class="t">${s.slice(11)}</td>${courts.map((c) => `<td><div class="cell" data-cell="${s}|${c.id}">${inSlot(s, c.id).map(card).join('')}</div></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  $$('[data-d]', el).forEach((b) => b.addEventListener('click', () => { f.day = b.dataset.d; render(); }));
  $('#printBtn').onclick = () => window.print();
  $('#autoBtn').onclick = () => {
    modal('Programación automática', `<p>Asigna pista y hora respetando duración (${dur} min), descanso mínimo (${sch.restMinutes} min) y que un mismo jugador no juegue dos partidos a la vez (aunque esté en dos categorías).</p>
      <div class="field"><label>Categorías</label>${S.categories.map((c) => `<label class="check"><input type="checkbox" class="acat" value="${c.id}" checked> ${esc(c.name)}</label>`).join('')}</div>
      <div class="field"><label>Modo</label><select id="amode"><option value="unscheduled">Solo partidos sin horario</option><option value="all">Reprogramar todo lo no jugado</option></select></div>`, { foot: '<button class="btn" id="ago">Programar</button>' });
    $('#ago').onclick = async () => {
      const ids = $$('.acat').filter((x) => x.checked).map((x) => x.value);
      const mode = $('#amode').value;
      closeModal();
      let res;
      await commit((d) => { res = E.autoSchedule(d, { mode, categoryIds: ids }); E.addLog(d, 'admin', `Programación automática: ${res.placed} partidos`); });
      if (res) toast(res.unplaced ? `Se programaron ${res.placed}; ${res.unplaced} no cupieron: agrega horas, días o pistas.` : `Se programaron ${res.placed} partidos ✓`, !!res.unplaced, 6000);
    };
  };
  // Arrastrar y soltar
  let dragId = null;
  $$('.smatch', el).forEach((c) => {
    c.addEventListener('dragstart', (e) => { dragId = c.dataset.m; e.dataTransfer.effectAllowed = 'move'; });
    c.addEventListener('click', () => openScore(c.dataset.m));
  });
  $$('[data-cell]', el).forEach((cell) => {
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('over');
      if (!dragId) return;
      const id = dragId;
      dragId = null;
      const target = cell.dataset.cell;
      await commit((d) => {
        const m = d.matches.find((x) => x.id === id);
        const old = { time: m.time, court: m.court };
        if (target === 'none') { m.time = null; m.court = null; return; }
        const [time, court] = target.split('|');
        const dayObj = d.schedule.days.find((x) => x.date === time.slice(0, 10));
        const other = d.matches.find((x) => x.id !== id && x.court === court && x.time && slotOf(x.time, dayObj, dur) === time);
        if (other) { other.time = old.time; other.court = old.court; }
        m.time = time;
        m.court = court;
      });
    });
  });
}
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const pad = (n) => String(n).padStart(2, '0');
function slotOf(time, day, dur) {
  if (!day || !time.startsWith(day.date)) return null;
  const t = toMin(time.slice(11));
  const s = toMin(day.start);
  const k = Math.max(0, Math.floor((t - s) / dur));
  const m = s + k * dur;
  return `${day.date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
function findConflicts() {
  const dur = Number(S.schedule.slotMinutes) || 75;
  const rest = Number(S.schedule.restMinutes) || 0;
  const byPlayer = new Map();
  for (const m of S.matches) {
    if (!m.time || m.status === 'cancelled' || m.status === 'bye') continue;
    for (const tid of [m.teamA, m.teamB]) {
      const t = C.team(tid);
      if (!t) continue;
      for (const p of [t.p1?.name, t.p2?.name].map(E.norm).filter(Boolean)) {
        if (!byPlayer.has(p)) byPlayer.set(p, []);
        byPlayer.get(p).push(m);
      }
    }
  }
  const out = new Set();
  for (const ms of byPlayer.values()) {
    const s = ms.slice().sort((a, b) => a.time.localeCompare(b.time));
    for (let i = 1; i < s.length; i++) {
      const gap = (parseLocal(s[i].time) - parseLocal(s[i - 1].time)) / 60000;
      if (gap < dur + rest) { out.add(s[i].id); out.add(s[i - 1].id); }
    }
  }
  return out;
}

// =====================================================================
// GRUPOS
// =====================================================================
function catPicker(key) {
  const f = (SUB[key] ||= { cat: S.categories[0]?.id || '' });
  if (!S.categories.some((c) => c.id === f.cat)) f.cat = S.categories[0]?.id || '';
  return f;
}
function catTabs(f) {
  return `<div class="tabs no-print">${S.categories.map((c) => `<button data-cat="${c.id}" class="${c.id === f.cat ? 'active' : ''}">${esc(c.name)}</button>`).join('')}</div>`;
}
function bindCatTabs(el, f) {
  $$('[data-cat]', el).forEach((b) => b.addEventListener('click', () => { f.cat = b.dataset.cat; SUB.proposal = null; render(); }));
}

function vGrupos(el) {
  if (!S.categories.length) { el.innerHTML = '<div class="card empty"><b>No hay categorías</b>Créalas en “Categorías y reglas”.</div>'; return; }
  const f = catPicker('grupos');
  const cat = S.categories.find((c) => c.id === f.cat);
  const cfg = cat.config.groups;
  const groups = S.groups.filter((g) => g.categoryId === cat.id).sort((a, b) => a.name.localeCompare(b.name));
  const teams = E.activeTeams(S, cat.id);
  const hasResults = S.matches.some((m) => m.categoryId === cat.id && E.isDone(m) && m.status !== 'bye');
  const prop = SUB.proposal && SUB.proposal.cat === cat.id ? SUB.proposal : null;
  let body;
  if (prop) {
    body = `<div class="alert info">Vista previa: ajusta las parejas con el selector y después pulsa <b>Aplicar grupos</b>. Nada se publica todavía.</div>
    <div class="grid grid-3">${prop.groups.map((g, gi) => `<div class="gbox"><h3>Grupo ${esc(g.name)} <span class="small muted">(${g.teamIds.length})</span></h3>${g.teamIds.map((id) => { const t = C.team(id); return `<div class="gteam"><span>${t?.seed ? `<b>[${t.seed}]</b> ` : ''}${esc(E.teamName(t))}${E.teamClub(t) ? `<span class="small muted"> · ${esc(t.p1.club || t.p2.club)}</span>` : ''}</span><select data-move="${id}" data-from="${gi}">${prop.groups.map((x, xi) => `<option value="${xi}" ${xi === gi ? 'selected' : ''}>→ ${esc(x.name)}</option>`).join('')}</select></div>`; }).join('')}</div>`).join('')}</div>
    <div class="row section"><button class="btn ghost" id="redraw">🔀 Volver a sortear</button><button class="btn ghost" id="cancelProp">Cancelar</button><span class="spacer"></span><button class="btn lg" id="applyProp">Aplicar grupos y crear partidos</button></div>`;
  } else if (groups.length) {
    body = `<div class="grid grid-2">${groups.map((g) => standingsTable(C, g, E.standings(S, g.id))).join('')}</div>
      ${groups.map((g) => `<div class="section"><h3 style="margin-bottom:8px">Partidos · Grupo ${esc(g.name)}</h3><div class="card list">${S.matches.filter((m) => m.groupId === g.id).map((m) => rowWithActions(m)).join('')}</div></div>`).join('')}`;
  } else body = `<div class="card empty"><b>Aún no hay grupos</b>${teams.length} parejas confirmadas. Revisa las reglas y pulsa “Generar grupos”.</div>`;

  el.innerHTML = `<div class="section-head"><h2>Grupos</h2><div class="row no-print">
      <label class="check" style="margin:0"><input type="checkbox" id="pubG" ${cat.publish.groups ? 'checked' : ''}> Publicar en el sitio</label>
      <button class="btn ghost printbtn" onclick="window.print()">🖨️</button>
      <button class="btn" id="genG">${groups.length ? 'Regenerar grupos' : 'Generar grupos'}</button></div></div>
    ${catTabs(f)}
    <p class="small muted">Reglas: ${cfg.mode === 'size' ? `grupos de ~${cfg.size}` : `${cfg.count} grupos`} · reparto ${{ seed: 'por siembra (serpentina)', random: 'aleatorio', manual: 'manual' }[cfg.draw]}${cfg.avoidSameClub ? ' · evita mismo club' : ''} · clasifican ${cfg.qualifyPerGroup}${cfg.bestThirds ? ` + ${cfg.bestThirds} mejores terceros` : ''} · ${esc(E.formatLabel(cat.config.groupFormat))} · Puntos: G ${cfg.points.win} / P ${cfg.points.loss} / W.O. ${cfg.points.woLoss} · <a href="#categorias" id="goRules">cambiar reglas</a></p>
    ${body}`;
  bindCatTabs(el, f);
  bindRowActions(el);
  $('#goRules').onclick = (e) => { e.preventDefault(); VIEW = 'categorias'; SUB.editCat = cat.id; render(); };
  $('#pubG').onchange = (e) => commit((d) => { d.categories.find((c) => c.id === cat.id).publish.groups = e.target.checked; }, e.target.checked ? 'Grupos publicados' : 'Grupos ocultos');
  const propose = () => {
    try {
      // En modo "manual" se parte de un reparto por siembra que luego ajustas en la vista previa
      const g = E.proposeGroups(S, cat.id);
      SUB.proposal = { cat: cat.id, groups: g };
      render();
    } catch (e) { toast(e.message, true); }
  };
  $('#genG').onclick = async () => {
    if (groups.length && !(await confirmBox(`Se borrarán los grupos actuales${hasResults ? ', <b>los resultados ya capturados</b>' : ''} y la llave de ${esc(cat.name)}. ¿Continuar?`, 'Sí, regenerar', true))) return;
    propose();
  };
  if (prop) {
    $('#redraw').onclick = propose;
    $('#cancelProp').onclick = () => { SUB.proposal = null; render(); };
    $$('[data-move]', el).forEach((s) => (s.onchange = () => {
      const from = Number(s.dataset.from);
      const to = Number(s.value);
      prop.groups[from].teamIds = prop.groups[from].teamIds.filter((x) => x !== s.dataset.move);
      prop.groups[to].teamIds.push(s.dataset.move);
      render();
    }));
    $('#applyProp').onclick = async () => {
      if (prop.groups.some((g) => g.teamIds.length < 2)) return toast('Cada grupo necesita al menos 2 parejas.', true);
      const ok = await commit((d) => E.applyGroups(d, cat.id, prop.groups), 'Grupos creados ✓');
      if (ok) { SUB.proposal = null; render(); }
    };
  }
}

// =====================================================================
// LLAVES
// =====================================================================
function vLlaves(el) {
  if (!S.categories.length) { el.innerHTML = '<div class="card empty"><b>No hay categorías</b></div>'; return; }
  const f = catPicker('llaves');
  const cat = S.categories.find((c) => c.id === f.cat);
  const ko = cat.config.ko;
  const hasGroups = S.groups.some((g) => g.categoryId === cat.id);
  const complete = E.groupsComplete(S, cat.id);
  const koMatches = S.matches.filter((m) => m.categoryId === cat.id && (m.stage === 'ko' || m.stage === 'third'));
  const cons = S.matches.filter((m) => m.categoryId === cat.id && m.stage === 'cons');
  const champ = E.champions(S, cat.id);
  let preview = '';
  if (hasGroups) {
    const q = E.qualifiers(S, cat.id);
    preview = `<details class="card section" ${koMatches.length ? '' : 'open'}><summary style="cursor:pointer;font-weight:700">Clasificados ${complete ? '' : '(provisional: faltan partidos de grupo)'} — ${q.qualified.length}</summary>
      <ol class="small" style="columns:2;margin:10px 0 0">${q.qualified.map((r) => `<li>${esc(C.tname(r.teamId))} <span class="muted">(${r.pos}º Gr. ${esc(r.groupName)})</span></li>`).join('')}</ol></details>`;
  }
  el.innerHTML = `<div class="section-head"><h2>Llaves</h2><div class="row no-print">
      <label class="check" style="margin:0"><input type="checkbox" id="pubK" ${cat.publish.ko ? 'checked' : ''}> Publicar en el sitio</label>
      <button class="btn ghost printbtn" onclick="window.print()">🖨️</button>
      ${ko.seeding === 'manual' || !hasGroups ? '<button class="btn ghost" id="manualK">Armar a mano</button>' : ''}
      <button class="btn" id="genK">${koMatches.length ? 'Regenerar llave' : 'Generar llave'}</button></div></div>
    ${catTabs(f)}
    <p class="small muted">Reglas: siembra ${{ cross: 'cruzada (1A vs 2B)', ranking: 'por ranking de grupos', random: 'aleatoria', manual: 'manual' }[ko.seeding]}${ko.avoidRematch ? ' · sin revancha de grupo en 1ª ronda' : ''}${ko.thirdPlace ? ' · partido por 3er lugar' : ''}${ko.consolation ? ' · llave de consolación' : ''}${ko.autoGenerate ? ' · se genera sola al terminar los grupos' : ''} · ${esc(E.formatLabel(cat.config.koFormat))}</p>
    ${champ ? podiumHtml(C, champ) : ''}
    ${preview}
    ${koMatches.length ? `<div class="card section"><h3 style="margin-bottom:8px">Llave principal</h3><p class="small muted no-print">Toca un partido para capturar el resultado.</p>${bracketHtml(C, koMatches, { clickable: true })}</div>` : '<div class="card empty section"><b>Aún no hay llave</b>Se genera con los clasificados de los grupos (o con todas las parejas confirmadas si la categoría no tiene grupos).</div>'}
    ${cons.length ? `<div class="card section"><h3 style="margin-bottom:8px">Consolación</h3>${bracketHtml(C, cons, { clickable: true })}</div>` : ''}`;
  bindCatTabs(el, f);
  $$('.bmatch', el).forEach((b) => b.addEventListener('click', () => { const m = S.matches.find((x) => x.id === b.dataset.id); if (m && m.status !== 'bye') openScore(m.id); }));
  $('#pubK').onchange = (e) => commit((d) => { d.categories.find((c) => c.id === cat.id).publish.ko = e.target.checked; }, e.target.checked ? 'Llave publicada' : 'Llave oculta');
  $('#genK').onclick = async () => {
    if (hasGroups && !complete && !(await confirmBox('Todavía hay partidos de grupo sin resultado. La llave se armará con la clasificación provisional. ¿Continuar?', 'Generar de todos modos'))) return;
    if (koMatches.some((m) => E.isDone(m) && m.status !== 'bye') && !(await confirmBox('La llave actual ya tiene resultados y se perderán. ¿Continuar?', 'Sí, regenerar', true))) return;
    if (ko.seeding === 'manual' && hasGroups) return manualBracket(cat);
    commit((d) => E.generateKnockout(d, cat.id), 'Llave generada ✓');
  };
  $('#manualK')?.addEventListener('click', () => manualBracket(cat));
}

function manualBracket(cat) {
  const hasGroups = S.groups.some((g) => g.categoryId === cat.id);
  const pool = hasGroups ? E.qualifiers(S, cat.id).qualified.map((r) => r.teamId) : E.activeTeams(S, cat.id).map((t) => t.id);
  const all = E.activeTeams(S, cat.id);
  let size = 2;
  while (size < pool.length) size *= 2;
  const order = E.bracketOrder(size);
  const opts = (sel) => `<option value="">BYE</option>` + all.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(E.teamName(t))}</option>`).join('');
  let rows = '';
  for (let i = 0; i < size; i += 2) {
    rows += `<div class="row" style="margin-bottom:8px"><b style="width:26px">${i / 2 + 1}</b><select class="mk" data-seed="${order[i]}">${opts(pool[order[i] - 1])}</select><span class="muted">vs</span><select class="mk" data-seed="${order[i + 1]}">${opts(pool[order[i + 1] - 1])}</select></div>`;
  }
  modal(`Armar llave a mano · ${esc(cat.name)}`, `<p class="small muted">Elige los cruces de la primera ronda. Deja “BYE” para que la otra pareja pase directo.</p>${rows}`, { wide: true, foot: '<button class="btn" id="mkGo">Crear llave</button>' });
  $('#mkGo').onclick = async () => {
    const bySeed = {};
    $$('.mk').forEach((s) => (bySeed[s.dataset.seed] = s.value || null));
    const chosen = Object.values(bySeed).filter(Boolean);
    if (new Set(chosen).size !== chosen.length) return toast('Hay una pareja repetida.', true);
    if (chosen.length < 2) return toast('Elige al menos 2 parejas.', true);
    // Construir lista por siembra (índice = seed-1)
    const entries = Array.from({ length: size }, (_, i) => bySeed[i + 1] || null);
    closeModal();
    await commit((d) => {
      E.buildBracket(d, cat.id, 'ko', entries.map((id) => (id ? { teamId: id } : null)), { thirdPlace: cat.config.ko.thirdPlace });
      const c = d.categories.find((x) => x.id === cat.id);
      c.status = 'knockout';
      E.addLog(d, 'admin', `${c.name}: llave armada a mano`);
    }, 'Llave creada ✓');
  };
}

// =====================================================================
// INSCRIPCIONES
// =====================================================================
const TEAM_STATUS = { pending: ['Por revisar', 'warn'], confirmed: ['Confirmada', 'ok'], waitlist: ['Lista de espera', ''], withdrawn: ['Baja', 'bad'] };
const PAY = { unpaid: ['Sin pago', 'bad'], partial: ['Parcial', 'warn'], paid: ['Pagado', 'ok'] };

function vInscripciones(el) {
  const f = (SUB.ins ||= { cat: '', st: '', q: '' });
  el.innerHTML = `<div class="section-head"><h2>Inscripciones</h2><div class="row no-print">
      <button class="btn ghost" id="csv">⬇️ Exportar CSV</button><button class="btn" id="addT">+ Agregar pareja</button></div></div>
    <div class="row no-print" style="margin-bottom:10px">
      <input type="search" id="iq" placeholder="Buscar nombre, teléfono o código…" value="${esc(f.q)}" style="max-width:260px">
      <select id="icat" style="max-width:200px">${catOptions(f.cat)}</select>
      <select id="ist" style="max-width:180px"><option value="">Todos los estados</option>${Object.entries(TEAM_STATUS).map(([k, [l]]) => `<option value="${k}" ${k === f.st ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div><div id="ilist"></div>`;
  const draw = () => {
    let ts = S.teams.slice();
    if (f.cat) ts = ts.filter((t) => t.categoryId === f.cat);
    if (f.st) ts = ts.filter((t) => t.status === f.st);
    const q = E.norm(f.q);
    if (q) ts = ts.filter((t) => E.norm([t.p1.name, t.p2.name, t.p1.phone, t.p2.phone, t.code, t.p1.email].join(' ')).includes(q));
    ts.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || (a.categoryId || '').localeCompare(b.categoryId || '') || (a.seed || 999) - (b.seed || 999));
    const counts = S.categories.map((c) => `<span class="chip">${esc(c.name)}: ${E.activeTeams(S, c.id).length}/${c.maxTeams}</span>`).join(' ');
    $('#ilist').innerHTML = `<div class="row small" style="margin-bottom:10px">${counts}</div>` + (ts.length
      ? `<div class="card table-scroll" style="padding:6px"><table class="tbl-admin"><thead><tr><th>Pareja</th><th>Categoría</th><th>Contacto</th><th>Siembra</th><th>Estado</th><th>Pago</th><th></th></tr></thead><tbody>${ts
          .map((t) => {
            const wa = (t.p1.phone || '').replace(/\D/g, '');
            return `<tr><td><b>${esc(t.p1.name)}</b><br><b>${esc(t.p2.name)}</b><div class="small muted">${esc(t.code || '')}${t.source === 'web' ? ' · web' : ''}${t.notes ? ' · ' + esc(t.notes) : ''}</div></td>
              <td>${esc(C.cat(t.categoryId)?.name || '—')}</td>
              <td class="small">${esc(t.p1.phone)}${wa ? ` <a href="https://wa.me/${wa.length === 10 ? '52' + wa : wa}" target="_blank" rel="noopener" title="WhatsApp">💬</a>` : ''}<br>${esc(t.p1.email || '')}</td>
              <td>${t.seed || '—'}</td>
              <td><span class="chip ${TEAM_STATUS[t.status][1]}">${TEAM_STATUS[t.status][0]}</span></td>
              <td><span class="chip ${PAY[t.paid][1]}">${PAY[t.paid][0]}</span></td>
              <td style="white-space:nowrap">${t.status === 'pending' ? `<button class="btn sm" data-ok="${t.id}">Confirmar</button> ` : ''}<button class="btn ghost sm" data-ed="${t.id}">Editar</button></td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : '<div class="card empty"><b>Sin inscripciones</b></div>');
    $$('[data-ed]').forEach((b) => (b.onclick = () => editTeam(b.dataset.ed)));
    $$('[data-ok]').forEach((b) => (b.onclick = () => commit((d) => { const t = d.teams.find((x) => x.id === b.dataset.ok); t.status = 'confirmed'; E.addLog(d, 'admin', `Inscripción confirmada: ${E.teamName(t)}`); }, 'Pareja confirmada ✓')));
  };
  $('#iq').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  $('#icat').addEventListener('change', (e) => { f.cat = e.target.value; draw(); });
  $('#ist').addEventListener('change', (e) => { f.st = e.target.value; draw(); });
  $('#addT').onclick = () => editTeam(null);
  $('#csv').onclick = exportCsv;
  draw();
}

function editTeam(id) {
  const t = id ? S.teams.find((x) => x.id === id) : E.makeTeam(S.categories[0]?.id || '', {}, {}, { status: 'confirmed', source: 'mesa' });
  if (!S.categories.length) return toast('Primero crea una categoría.', true);
  const pf = (n, p) => `<div class="card" style="box-shadow:none;border:1px solid var(--line)"><b>Jugador ${n}</b><div class="form-grid" style="margin-top:8px">
    ${[['name', 'Nombre'], ['phone', 'Teléfono'], ['email', 'Correo'], ['city', 'Ciudad'], ['club', 'Club']].map(([k, l]) => `<div class="field"><label>${l}</label><input type="text" data-p="${n}.${k}" value="${esc(p[k] || '')}"></div>`).join('')}</div></div>`;
  const inMatches = id && S.matches.some((m) => m.teamA === id || m.teamB === id);
  modal(id ? 'Editar pareja' : 'Agregar pareja', `
    <div class="form-grid"><div class="field"><label>Categoría</label><select id="tcat" ${inMatches ? 'disabled title="Ya tiene partidos"' : ''}>${catOptions(t.categoryId, false)}</select></div>
    <div class="field"><label>Siembra / ranking</label><input type="number" id="tseed" min="1" value="${t.seed || ''}" placeholder="Opcional"></div>
    <div class="field"><label>Estado</label><select id="tst">${Object.entries(TEAM_STATUS).map(([k, [l]]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Pago</label><select id="tpay">${Object.entries(PAY).map(([k, [l]]) => `<option value="${k}" ${k === t.paid ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Referencia de pago</label><input type="text" id="tref" value="${esc(t.payRef || '')}"></div></div>
    <div class="grid">${pf(1, t.p1)}${pf(2, t.p2)}</div>
    <div class="field" style="margin-top:12px"><label>Notas internas</label><textarea id="tnotes">${esc(t.notes || '')}</textarea></div>
    ${inMatches ? '<p class="small muted">Esta pareja ya tiene partidos: para quitarla del torneo márcala como “Baja” y registra W.O. en sus partidos pendientes.</p>' : ''}`,
    { wide: true, foot: `${id && !inMatches ? '<button class="btn danger" id="tdel">Eliminar</button><span class="spacer"></span>' : ''}<button class="btn ghost" id="tcancel">Cancelar</button><button class="btn" id="tsave">Guardar</button>` });
  $('#tcancel').onclick = closeModal;
  $('#tdel')?.addEventListener('click', async () => {
    if (!(await confirmBox('¿Eliminar esta inscripción definitivamente?', 'Eliminar', true))) return;
    commit((d) => { d.teams = d.teams.filter((x) => x.id !== id); d.groups.forEach((g) => (g.teamIds = g.teamIds.filter((x) => x !== id))); E.addLog(d, 'admin', `Inscripción eliminada: ${E.teamName(t)}`); }, 'Eliminada');
  });
  $('#tsave').onclick = async () => {
    const data = E.clone(t);
    $$('[data-p]').forEach((i) => { const [n, k] = i.dataset.p.split('.'); data['p' + n][k] = i.value.trim(); });
    if (!data.p1.name || !data.p2.name) return toast('Escribe el nombre de los dos jugadores.', true);
    data.categoryId = $('#tcat').value;
    data.seed = Number($('#tseed').value) || null;
    data.status = $('#tst').value;
    data.paid = $('#tpay').value;
    data.payRef = $('#tref').value.trim();
    data.notes = $('#tnotes').value.trim();
    const ok = await commit((d) => {
      const i = d.teams.findIndex((x) => x.id === data.id);
      if (i >= 0) d.teams[i] = data;
      else d.teams.push(data);
      E.addLog(d, 'admin', `${i >= 0 ? 'Pareja editada' : 'Pareja agregada'}: ${E.teamName(data)}`);
    }, 'Guardado ✓');
    if (ok) closeModal();
  };
}

function exportCsv() {
  const head = ['Código', 'Categoría', 'Estado', 'Pago', 'Referencia', 'Siembra', 'Jugador 1', 'Tel 1', 'Correo 1', 'Club 1', 'Ciudad 1', 'Jugador 2', 'Tel 2', 'Correo 2', 'Club 2', 'Ciudad 2', 'Notas', 'Fecha'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = S.teams.map((t) => [t.code, C.cat(t.categoryId)?.name, TEAM_STATUS[t.status][0], PAY[t.paid][0], t.payRef, t.seed, t.p1.name, t.p1.phone, t.p1.email, t.p1.club, t.p1.city, t.p2.name, t.p2.phone, t.p2.email, t.p2.club, t.p2.city, t.notes, t.createdAt?.slice(0, 10)].map(q).join(','));
  download(`inscripciones-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + [head.map(q).join(','), ...rows].join('\n'), 'text/csv');
}
async function download(name, content, type) {
  if (A.download) {
    try { await A.download(name, content, type); } catch (e) { toast('No se pudo descargar: ' + (e.message || e), true); }
    return;
  }
  const blob = new Blob([content], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// =====================================================================
// CATEGORÍAS Y REGLAS
// =====================================================================
function vCategorias(el) {
  el.innerHTML = `<div class="section-head"><h2>Categorías y reglas</h2><button class="btn" id="addC">+ Nueva categoría</button></div>
    <div class="grid grid-2">${S.categories.map((c) => `<div class="card"><div class="row"><h3>${esc(c.name)}</h3><span class="spacer"></span><span class="chip">${CAT_STATUS[c.status]}</span></div>
      <p class="small muted">${E.activeTeams(S, c.id).length}/${c.maxTeams} parejas · Grupos: ${esc(E.formatLabel(c.config.groupFormat))} · Llave: ${esc(E.formatLabel(c.config.koFormat))}</p>
      <div class="row"><button class="btn sm" data-ec="${c.id}">Editar reglas</button><button class="btn ghost sm" data-dup="${c.id}">Duplicar</button>${S.teams.some((t) => t.categoryId === c.id) ? '' : `<button class="btn ghost sm" data-delc="${c.id}">Eliminar</button>`}</div></div>`).join('') || '<div class="card empty"><b>Crea tu primera categoría</b>Ej. Varonil 1ra, Femenil 3ra, Mixto B…</div>'}</div>`;
  $('#addC').onclick = () => editCategory(null);
  $$('[data-ec]').forEach((b) => (b.onclick = () => editCategory(b.dataset.ec)));
  $$('[data-dup]').forEach((b) => (b.onclick = () => commit((d) => {
    const src = d.categories.find((c) => c.id === b.dataset.dup);
    const c = E.addCategory(d, src.name + ' (copia)', { maxTeams: src.maxTeams, fee: src.fee });
    c.config = E.clone(src.config);
  }, 'Categoría duplicada')));
  $$('[data-delc]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('¿Eliminar esta categoría?', 'Eliminar', true))) return;
    commit((d) => { d.categories = d.categories.filter((c) => c.id !== b.dataset.delc); d.groups = d.groups.filter((g) => g.categoryId !== b.dataset.delc); d.matches = d.matches.filter((m) => m.categoryId !== b.dataset.delc); }, 'Eliminada');
  }));
  if (SUB.editCat) { const id = SUB.editCat; SUB.editCat = null; editCategory(id); }
}

function formatFields(prefix, fmt) {
  return `<div class="form-grid">
    <div class="field"><label>Formato</label><select id="${prefix}type"><option value="bo3" ${fmt.type === 'bo3' ? 'selected' : ''}>Mejor de 3 sets</option><option value="oneSet" ${fmt.type === 'oneSet' ? 'selected' : ''}>Un solo set (pro-set)</option></select></div>
    <div class="field"><label>Games por set</label><input type="number" id="${prefix}games" min="3" max="12" value="${fmt.setGames}"></div></div>
    <label class="check"><input type="checkbox" id="${prefix}tb" ${fmt.tiebreak ? 'checked' : ''}> Tie-break al empatar (6-6 → 7-6; en pro-set a 9: 8-8 → 9-8)</label>
    <label class="check"><input type="checkbox" id="${prefix}stb" ${fmt.superTB ? 'checked' : ''}> 3er set = súper tie-break a 10 puntos</label>
    <label class="check"><input type="checkbox" id="${prefix}gp" ${fmt.goldenPoint ? 'checked' : ''}> Punto de oro (informativo)</label>`;
}
const readFormat = (p) => ({ type: $(`#${p}type`).value, setGames: Number($(`#${p}games`).value) || 6, tiebreak: $(`#${p}tb`).checked, superTB: $(`#${p}stb`).checked, goldenPoint: $(`#${p}gp`).checked });

function editCategory(id) {
  const c = id ? E.clone(S.categories.find((x) => x.id === id)) : { name: '', maxTeams: 16, fee: '', status: 'registration', publish: { groups: false, ko: false }, config: E.defaultCategoryConfig() };
  const g = c.config.groups;
  const ko = c.config.ko;
  let tbs = g.tiebreakers.slice();
  const tbHtml = () => {
    const off = Object.keys(E.TIEBREAKERS).filter((k) => !tbs.includes(k));
    return tbs.map((k, i) => `<div class="tb-item"><span class="n">${i + 1}</span>${E.TIEBREAKERS[k]}<span class="spacer"></span><button type="button" class="btn ghost sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn ghost sm" data-down="${i}" ${i === tbs.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn ghost sm" data-rm="${i}">✕</button></div>`).join('') +
      off.map((k) => `<div class="tb-item off"><span class="n">–</span>${E.TIEBREAKERS[k]}<span class="spacer"></span><button type="button" class="btn ghost sm" data-add="${k}">Agregar</button></div>`).join('');
  };
  const sel = (idv, opts, cur) => `<select id="${idv}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  modal(id ? `Reglas · ${esc(c.name)}` : 'Nueva categoría', `
    <div class="form-grid">
      <div class="field"><label>Nombre</label><input type="text" id="cname" value="${esc(c.name)}" placeholder="Ej. Varonil 2da"></div>
      <div class="field"><label>Cupo máximo (parejas)</label><input type="number" id="cmax" min="2" value="${c.maxTeams}"></div>
      <div class="field"><label>Costo (texto, opcional)</label><input type="text" id="cfee" value="${esc(c.fee || '')}" placeholder="$1,200 por pareja"></div>
      <div class="field"><label>Etapa actual</label>${sel('cstatus', Object.entries(CAT_STATUS), c.status)}</div>
    </div>
    <h3 class="section">1 · Fase de grupos</h3>
    <div class="form-grid">
      <div class="field"><label>Cómo armar los grupos</label>${sel('gmode', [['size', 'Por tamaño de grupo'], ['count', 'Por número de grupos']], g.mode)}</div>
      <div class="field"><label>Parejas por grupo</label>${sel('gsize', [[3, '3'], [4, '4'], [5, '5'], [6, '6']], g.size)}</div>
      <div class="field"><label>Número de grupos</label><input type="number" id="gcount" min="1" value="${g.count}"></div>
      <div class="field"><label>Reparto</label>${sel('gdraw', [['seed', 'Por siembra (serpentina)'], ['random', 'Sorteo aleatorio'], ['manual', 'Manual (ajusto la vista previa)']], g.draw)}</div>
      <div class="field"><label>Clasifican por grupo</label><input type="number" id="gq" min="1" value="${g.qualifyPerGroup}"></div>
      <div class="field"><label>+ Mejores terceros</label><input type="number" id="gbt" min="0" value="${g.bestThirds}"></div>
      <div class="field"><label>Puntos por victoria</label><input type="number" id="pw" min="0" value="${g.points.win}"></div>
      <div class="field"><label>Puntos por derrota</label><input type="number" id="pl" min="0" value="${g.points.loss}"></div>
      <div class="field"><label>Puntos por derrota con W.O.</label><input type="number" id="pwo" min="0" value="${g.points.woLoss}"></div>
    </div>
    <label class="check"><input type="checkbox" id="gclub" ${g.avoidSameClub ? 'checked' : ''}> Evitar parejas del mismo club en el mismo grupo</label>
    <div class="field section"><label>Orden de desempate</label><div class="tb-list" id="tbl">${tbHtml()}</div></div>
    <h4 style="margin:14px 0 6px">Formato de partido en grupos</h4>${formatFields('gf', c.config.groupFormat)}
    <h3 class="section">2 · Eliminatorias</h3>
    <div class="form-grid">
      <div class="field"><label>Siembra de la llave</label>${sel('kseed', [['cross', 'Cruzada (1A vs 2B…)'], ['ranking', 'Por ranking de grupos'], ['random', 'Aleatoria'], ['manual', 'Manual']], ko.seeding)}</div>
    </div>
    <label class="check"><input type="checkbox" id="krm" ${ko.avoidRematch ? 'checked' : ''}> Evitar revancha de grupo en la 1ª ronda</label>
    <label class="check"><input type="checkbox" id="k3" ${ko.thirdPlace ? 'checked' : ''}> Jugar partido por 3er lugar</label>
    <label class="check"><input type="checkbox" id="kcons" ${ko.consolation ? 'checked' : ''}> Llave de consolación para eliminados en grupos</label>
    <label class="check"><input type="checkbox" id="kauto" ${ko.autoGenerate ? 'checked' : ''}> Generar la llave automáticamente al terminar los grupos</label>
    <h4 style="margin:14px 0 6px">Formato de partido en eliminatorias</h4>${formatFields('kf', c.config.koFormat)}
    <h3 class="section">3 · Publicación</h3>
    <label class="check"><input type="checkbox" id="pg" ${c.publish.groups ? 'checked' : ''}> Mostrar grupos y sus partidos en el sitio</label>
    <label class="check"><input type="checkbox" id="pk" ${c.publish.ko ? 'checked' : ''}> Mostrar la llave en el sitio</label>
    <p class="small muted">Cambiar el formato no altera resultados ya capturados; los nuevos se validan con las reglas nuevas.</p>`,
    { wide: true, foot: '<button class="btn ghost" id="ccancel">Cancelar</button><button class="btn" id="csave">Guardar reglas</button>' });
  const redrawTb = () => {
    $('#tbl').innerHTML = tbHtml();
    $$('#tbl [data-up]').forEach((b) => (b.onclick = () => { const i = +b.dataset.up; [tbs[i - 1], tbs[i]] = [tbs[i], tbs[i - 1]]; redrawTb(); }));
    $$('#tbl [data-down]').forEach((b) => (b.onclick = () => { const i = +b.dataset.down; [tbs[i + 1], tbs[i]] = [tbs[i], tbs[i + 1]]; redrawTb(); }));
    $$('#tbl [data-rm]').forEach((b) => (b.onclick = () => { tbs.splice(+b.dataset.rm, 1); redrawTb(); }));
    $$('#tbl [data-add]').forEach((b) => (b.onclick = () => { tbs.push(b.dataset.add); redrawTb(); }));
  };
  redrawTb();
  $('#ccancel').onclick = closeModal;
  $('#csave').onclick = async () => {
    const name = $('#cname').value.trim();
    if (!name) return toast('Ponle nombre a la categoría.', true);
    if (!tbs.length) return toast('Deja al menos un criterio de desempate.', true);
    const cfg = {
      groups: { mode: $('#gmode').value, size: +$('#gsize').value, count: +$('#gcount').value || 1, draw: $('#gdraw').value, avoidSameClub: $('#gclub').checked, qualifyPerGroup: +$('#gq').value || 1, bestThirds: +$('#gbt').value || 0, points: { win: +$('#pw').value || 0, loss: +$('#pl').value || 0, woLoss: +$('#pwo').value || 0 }, tiebreakers: tbs },
      groupFormat: readFormat('gf'),
      koFormat: readFormat('kf'),
      ko: { seeding: $('#kseed').value, avoidRematch: $('#krm').checked, thirdPlace: $('#k3').checked, consolation: $('#kcons').checked, autoGenerate: $('#kauto').checked },
    };
    const ok = await commit((d) => {
      let cat = id ? d.categories.find((x) => x.id === id) : E.addCategory(d, name);
      Object.assign(cat, { name, maxTeams: +$('#cmax').value || 16, fee: $('#cfee').value.trim(), status: $('#cstatus').value, publish: { groups: $('#pg').checked, ko: $('#pk').checked }, config: cfg });
      E.addLog(d, 'admin', `Reglas actualizadas: ${name}`);
    }, 'Reglas guardadas ✓');
    if (ok) closeModal();
  };
}

// =====================================================================
// TORNEO Y PISTAS
// =====================================================================
function vTorneo(el) {
  const t = S.tournament;
  const sch = S.schedule;
  const inp = (k, l, type = 'text', ph = '') => `<div class="field"><label>${l}</label><input type="${type}" data-t="${k}" value="${esc(t[k] ?? '')}" placeholder="${esc(ph)}"></div>`;
  el.innerHTML = `<div class="section-head"><h2>Torneo y pistas</h2><button class="btn lg" id="saveT">Guardar cambios</button></div>
  <div class="card"><h3 style="margin-bottom:10px">Datos generales</h3><div class="form-grid">
    ${inp('name', 'Nombre del torneo')}${inp('subtitle', 'Subtítulo')}${inp('dates', 'Fechas (texto)', 'text', '14 y 15 de noviembre')}${inp('venue', 'Sede')}${inp('address', 'Dirección')}${inp('whatsapp', 'WhatsApp de contacto', 'tel', '521312…')}${inp('logoUrl', 'URL del logo', 'url', 'https://…')}
    <div class="field"><label>Color principal</label><input type="color" data-t="primary" value="${esc(t.primary)}" style="height:42px;width:100%"></div>
    <div class="field"><label>Color de acento</label><input type="color" data-t="accent" value="${esc(t.accent)}" style="height:42px;width:100%"></div>
  </div></div>
  <div class="card section"><h3 style="margin-bottom:10px">Inscripciones</h3>
    <label class="check"><input type="checkbox" data-t="registrationOpen" ${t.registrationOpen ? 'checked' : ''}> Inscripciones abiertas en el sitio</label>
    <div class="form-grid" style="margin-top:10px">${inp('deadline', 'Fecha límite', 'date')}${inp('fee', 'Costo general (texto)')}</div>
    <div class="field"><label>Instrucciones de pago</label><textarea data-t="paymentInfo">${esc(t.paymentInfo)}</textarea></div>
    <div class="field"><label>Reglamento</label><textarea data-t="rulesText" style="min-height:120px">${esc(t.rulesText)}</textarea></div>
    <div class="field"><label>Aviso en el sitio</label><input type="text" data-t="announcement" value="${esc(t.announcement)}"></div>
  </div>
  <div class="card section"><h3 style="margin-bottom:10px">Pistas</h3><div id="courts"></div><button class="btn ghost sm" id="addCourt">+ Agregar pista</button></div>
  <div class="card section"><h3 style="margin-bottom:10px">Días y horarios de juego</h3>
    <div class="form-grid"><div class="field"><label>Duración por partido (min)</label><input type="number" id="slot" min="20" step="5" value="${sch.slotMinutes}"></div>
    <div class="field"><label>Descanso mínimo entre partidos de un jugador (min)</label><input type="number" id="rest" min="0" step="5" value="${sch.restMinutes}"></div></div>
    <div id="days"></div><button class="btn ghost sm" id="addDay">+ Agregar día</button></div>
  <div class="card section"><h3 style="margin-bottom:10px">Patrocinadores</h3><div id="spons"></div><button class="btn ghost sm" id="addSp">+ Agregar patrocinador</button></div>`;

  const courts = E.clone(S.courts);
  const days = E.clone(sch.days);
  const spons = E.clone(t.sponsors || []);
  const drawCourts = () => {
    $('#courts').innerHTML = courts.map((c, i) => `<div class="row" style="margin-bottom:8px"><input type="text" value="${esc(c.name)}" data-cn="${i}" style="max-width:220px"><label class="check" style="margin:0"><input type="checkbox" data-ca="${i}" ${c.active ? 'checked' : ''}> Activa</label>${S.matches.some((m) => m.court === c.id) ? '' : `<button class="btn ghost sm" data-cd="${i}">Quitar</button>`}</div>`).join('');
    $$('[data-cn]').forEach((x) => (x.oninput = () => (courts[x.dataset.cn].name = x.value)));
    $$('[data-ca]').forEach((x) => (x.onchange = () => (courts[x.dataset.ca].active = x.checked)));
    $$('[data-cd]').forEach((x) => (x.onclick = () => { courts.splice(+x.dataset.cd, 1); drawCourts(); }));
  };
  const drawDays = () => {
    $('#days').innerHTML = days.map((d, i) => `<div class="row" style="margin-bottom:8px"><input type="date" value="${d.date}" data-dd="${i}" style="max-width:170px"><input type="time" value="${d.start}" data-ds="${i}" style="max-width:120px"><span>a</span><input type="time" value="${d.end}" data-de="${i}" style="max-width:120px"><button class="btn ghost sm" data-dx="${i}">Quitar</button></div>`).join('') || '<p class="small muted">Sin días configurados.</p>';
    $$('[data-dd]').forEach((x) => (x.onchange = () => (days[x.dataset.dd].date = x.value)));
    $$('[data-ds]').forEach((x) => (x.onchange = () => (days[x.dataset.ds].start = x.value)));
    $$('[data-de]').forEach((x) => (x.onchange = () => (days[x.dataset.de].end = x.value)));
    $$('[data-dx]').forEach((x) => (x.onclick = () => { days.splice(+x.dataset.dx, 1); drawDays(); }));
  };
  const drawSp = () => {
    $('#spons').innerHTML = spons.map((s, i) => `<div class="row" style="margin-bottom:8px"><input type="text" placeholder="Nombre" value="${esc(s.name)}" data-sn="${i}" style="max-width:200px"><input type="url" placeholder="Logo (URL)" value="${esc(s.logo)}" data-sl="${i}" style="max-width:240px"><input type="url" placeholder="Sitio web" value="${esc(s.url)}" data-su="${i}" style="max-width:220px"><button class="btn ghost sm" data-sx="${i}">Quitar</button></div>`).join('');
    $$('[data-sn]').forEach((x) => (x.oninput = () => (spons[x.dataset.sn].name = x.value)));
    $$('[data-sl]').forEach((x) => (x.oninput = () => (spons[x.dataset.sl].logo = x.value)));
    $$('[data-su]').forEach((x) => (x.oninput = () => (spons[x.dataset.su].url = x.value)));
    $$('[data-sx]').forEach((x) => (x.onclick = () => { spons.splice(+x.dataset.sx, 1); drawSp(); }));
  };
  drawCourts(); drawDays(); drawSp();
  $('#addCourt').onclick = () => { courts.push({ id: E.uid('c_'), name: `Pista ${courts.length + 1}`, active: true }); drawCourts(); };
  $('#addDay').onclick = () => { const last = days[days.length - 1]; const next = last ? new Date(parseLocal(last.date + 'T12:00').getTime() + 864e5) : new Date(); days.push({ date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, start: '08:00', end: '22:00' }); drawDays(); };
  $('#addSp').onclick = () => { spons.push({ name: '', logo: '', url: '' }); drawSp(); };
  $('#saveT').onclick = () => commit((d) => {
    $$('[data-t]').forEach((i) => { d.tournament[i.dataset.t] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
    d.tournament.sponsors = spons.filter((s) => s.name || s.logo);
    d.courts = courts.filter((c) => c.name.trim());
    d.schedule.days = days.filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date));
    d.schedule.slotMinutes = +$('#slot').value || 75;
    d.schedule.restMinutes = +$('#rest').value || 0;
    E.addLog(d, 'admin', 'Datos del torneo actualizados');
  }, 'Cambios guardados ✓');
}

// =====================================================================
// HISTORIAL Y RESPALDO
// =====================================================================
function vHistorial(el) {
  el.innerHTML = `<div class="section-head"><h2>Historial y respaldo</h2></div>
  <div class="grid grid-2">
    <div class="card"><h3 style="margin-bottom:8px">Respaldo</h3><p class="small muted">Descarga todo el torneo en un archivo JSON. Sirve para pasar datos entre la mesa de control interna y el sitio de Netlify.</p>
      <div class="row"><button class="btn" id="exp">⬇️ Exportar JSON</button><label class="btn ghost" style="cursor:pointer">⬆️ Importar JSON<input type="file" id="imp" accept="application/json,.json" hidden></label></div></div>
    <div class="card"><h3 style="margin-bottom:8px">Pruebas</h3><p class="small muted">Carga un torneo de ejemplo (3 categorías, resultados parciales) para practicar, o empieza de cero.</p>
      <div class="row"><button class="btn ghost" id="demo">Cargar demo</button><button class="btn danger" id="reset">Torneo nuevo vacío</button></div></div>
  </div>
  ${A.history ? '<div class="card section"><h3 style="margin-bottom:8px">Versiones guardadas</h3><p class="small muted">Cada guardado crea una versión. Puedes volver a cualquiera de las últimas 40.</p><div id="vers" class="small">Cargando…</div></div>' : ''}
  <div class="card section"><h3 style="margin-bottom:8px">Bitácora de cambios</h3>${(S.log || []).map((l) => `<div class="log-item ${l.undone ? 'undone' : ''}"><time>${new Date(l.t).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time><span class="chip">${esc(l.who)}</span><span style="flex:1">${esc(l.msg)}</span>${l.type === 'match' && !l.undone ? `<button class="btn ghost sm" data-undo="${l.id}">Deshacer</button>` : ''}</div>`).join('') || '<p class="muted">Sin cambios todavía.</p>'}</div>`;
  $('#exp').onclick = () => download(`torneo-${E.norm(S.tournament.name).replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`, JSON.stringify(S, null, 1), 'application/json');
  $('#imp').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.tournament || !Array.isArray(data.matches) || !Array.isArray(data.teams)) throw new Error('El archivo no es un respaldo del torneo.');
      if (!(await confirmBox(`Se reemplazará todo el torneo actual por “${esc(data.tournament.name)}” (${data.teams.length} parejas, ${data.matches.length} partidos). ¿Continuar?`, 'Importar', true))) return;
      await commit((d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, data); E.addLog(d, 'admin', 'Torneo importado desde archivo'); }, 'Importado ✓');
    } catch (ex) { toast(ex.message, true); }
  };
  $('#demo').onclick = async () => {
    if (!(await confirmBox('Se reemplazará el torneo actual por datos de demostración. ¿Continuar?', 'Cargar demo', true))) return;
    try { setState(await A.demo(), ROLE); toast('Demo cargada'); } catch (e) { handleErr(e); }
  };
  $('#reset').onclick = async () => {
    if (!(await confirmBox('Se borrará TODO (categorías, parejas, partidos). Exporta un respaldo antes. ¿Continuar?', 'Borrar todo', true))) return;
    commit((d) => { const keep = { tournament: d.tournament, courts: d.courts, schedule: d.schedule }; Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, E.newTournament(), keep, { version: S.version }); E.addLog(d, 'admin', 'Torneo reiniciado'); }, 'Torneo vacío listo');
  };
  $$('[data-undo]').forEach((b) => (b.onclick = async () => { try { setState(await A.undo(b.dataset.undo), ROLE); toast('Cambio deshecho'); } catch (e) { handleErr(e); } }));
  if (A.history) {
    A.history().then((items) => {
      const box = $('#vers');
      if (!box) return;
      box.innerHTML = items.length ? items.map((i) => `<div class="log-item"><time>${new Date(i.updatedAt).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time><span class="chip">v${i.version}</span><span style="flex:1">${esc(i.last)}</span><button class="btn ghost sm" data-rest="${esc(i.key)}">Restaurar</button></div>`).join('') : 'Aún no hay versiones anteriores.';
      $$('[data-rest]').forEach((b) => (b.onclick = async () => {
        if (!(await confirmBox('¿Volver a esta versión? (La actual también queda guardada en el historial.)', 'Restaurar'))) return;
        try { setState(await A.restore(b.dataset.rest), ROLE); toast('Versión restaurada'); } catch (e) { handleErr(e); }
      }));
    }).catch((e) => { const box = $('#vers'); if (box) box.textContent = e.message; });
  }
}
