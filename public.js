// Sitio público del torneo (solo lectura + formulario de inscripción)
import { Engine as E } from './engine.js';
import {
  esc, $, $$, ctx, matchRow, matchesByDay, standingsTable, bracketHtml, podiumHtml, championsFrom,
  fmtTime, fmtDay, fmtDayLong, parseLocal, applyTheme, toast,
} from './ui.js';

const POLL_MS = 15000;
let DATA = null;
let C = null;
let lastFetch = null;
let searchQ = '';
let tvTimer = null;
let tvIndex = 0;

// ------------------------------------------------------------------
// Datos y actualización automática
// ------------------------------------------------------------------
async function fetchData(force = false) {
  try {
    const v = DATA && !force ? `?v=${DATA.version}` : '';
    const res = await fetch('/api/public' + v, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    lastFetch = new Date();
    if (j.changed) {
      const first = !DATA;
      DATA = j;
      C = ctx(DATA);
      applyTheme(DATA.tournament);
      if (first) route();
      else refreshView();
    }
    updStamp();
  } catch (e) {
    $('#upd').textContent = 'Sin conexión, reintentando…';
  }
}
function updStamp() {
  if (!lastFetch) return;
  $('#upd').textContent = `Última actualización: ${lastFetch.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}
setInterval(() => document.visibilityState === 'visible' && fetchData(), POLL_MS);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && fetchData());
$('#refresh').addEventListener('click', () => fetchData(true));

// ------------------------------------------------------------------
// Ruteo
// ------------------------------------------------------------------
function parts() {
  return (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

function route() {
  if (!DATA) return;
  const [r = 'home', a, b] = parts();
  document.body.classList.toggle('tv', r === 'vivo');
  clearInterval(tvTimer);
  $$('#nav a').forEach((x) => x.classList.toggle('active', x.dataset.r === (r === 'cat' ? 'categorias' : r)));
  renderChrome(r);
  const views = { home: viewHome, partidos: viewPartidos, categorias: viewCategorias, cat: () => viewCat(a, b), inscripciones: viewInscripciones, vivo: viewTV };
  (views[r] || viewHome)();
}

// Actualización por sondeo: no se re-dibuja el formulario mientras escribes
function refreshView() {
  const [r = 'home'] = parts();
  renderChrome(r);
  if (r === 'inscripciones') return updateSpots();
  if (r === 'home') return homeDynamic();
  route();
}

function renderChrome(r) {
  const t = DATA.tournament;
  document.title = `${t.name} · ${t.subtitle || 'Partidos y resultados'}`;
  $('#brand').innerHTML = `${t.logoUrl ? `<img src="${esc(t.logoUrl)}" alt="">` : '<span class="dot"></span>'}<span class="t">${esc(t.name)}</span>`;
  $('#banner').classList.toggle('hidden', !t.announcement);
  $('#bannerText').textContent = t.announcement || '';
  $('#foot').textContent = [t.venue, t.address].filter(Boolean).join(' · ');
  $('#hero').innerHTML = r === 'home' ? heroHtml(t) : '';
  if (r === 'home') startCountdown();
}

function heroHtml(t) {
  return `<section class="hero"><div class="wrap">
    <div class="small" style="opacity:.8;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Bienvenido a</div>
    <h1>${esc(t.name)}</h1>
    ${t.subtitle ? `<div class="sub">${esc(t.subtitle)}</div>` : ''}
    <div class="meta">${t.dates ? `<span>📅 ${esc(t.dates)}</span>` : ''}${t.venue ? `<span>📍 ${esc(t.venue)}</span>` : ''}</div>
    <div class="countdown" id="countdown"></div>
  </div></section>`;
}

let cdTimer = null;
function startCountdown() {
  clearInterval(cdTimer);
  const day = DATA.days?.[0];
  const el = $('#countdown');
  if (!day || !el) return;
  const target = parseLocal(`${day.date}T${day.start || '08:00'}`);
  const tick = () => {
    const ms = target - new Date();
    if (ms <= 0) { el.innerHTML = ''; clearInterval(cdTimer); return; }
    const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    el.innerHTML = [[d, 'días'], [h, 'horas'], [m, 'min'], [s, 'seg']].map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`).join('');
  };
  tick();
  cdTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------------
// Inicio
// ------------------------------------------------------------------
function viewHome() {
  $('#app').innerHTML = `
    <div class="search no-print"><input id="q" type="search" placeholder="Escribe tu nombre o el de tu pareja para ver tus partidos" autocomplete="off" value="${esc(searchQ)}"></div>
    <div id="results"></div>
    <div id="live"></div>
    <div class="section"><div class="section-head"><h2>Categorías</h2><a href="#/inscripciones" class="btn accent sm" id="ctaReg">Inscríbete</a></div><div class="grid grid-3" id="cats"></div></div>
    <div id="spons"></div>`;
  $('#q').addEventListener('input', (e) => { searchQ = e.target.value; renderResults(); });
  homeDynamic();
}

function homeDynamic() {
  renderResults();
  const live = DATA.matches.filter((m) => m.status === 'playing' || m.status === 'called');
  const now = new Date();
  const upcoming = DATA.matches
    .filter((m) => m.status === 'scheduled' && m.time && m.teamA && m.teamB && parseLocal(m.time) >= new Date(now - 30 * 60000))
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, 6);
  $('#live').innerHTML =
    (live.length ? `<div class="section"><div class="section-head"><h2>En juego ahora</h2></div><div class="card list">${live.map((m) => matchRow(C, m)).join('')}</div></div>` : '') +
    (upcoming.length ? `<div class="section"><div class="section-head"><h2>Próximos partidos</h2><a href="#/partidos" class="small">Ver todos →</a></div><div class="card list">${upcoming.map((m) => matchRow(C, m)).join('')}</div></div>` : '');
  $('#cats').innerHTML = DATA.categories.map(catCard).join('') || '<div class="card empty"><b>Pronto publicaremos las categorías</b></div>';
  $('#ctaReg').classList.toggle('hidden', !DATA.tournament.registrationOpen);
  const sp = DATA.tournament.sponsors || [];
  $('#spons').innerHTML = sp.length
    ? `<div class="section"><div class="section-head"><h2>Patrocinadores</h2></div><div class="sponsors">${sp
        .map((s) => `<a class="sponsor" ${s.url ? `href="${esc(s.url)}" target="_blank" rel="noopener"` : ''}>${s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}">` : esc(s.name)}</a>`)
        .join('')}</div></div>`
    : '';
}

const STATUS_CAT = { registration: ['Inscripciones', 'ok'], groups: ['Fase de grupos', 'live'], knockout: ['Eliminatorias', 'live'], finished: ['Finalizada', 'done'] };
function catCard(c) {
  const [label, cls] = STATUS_CAT[c.status] || ['', ''];
  const spots = c.status === 'registration' ? `<div class="small muted">${Math.max(0, c.maxTeams - c.spotsTaken)} lugares disponibles de ${c.maxTeams}</div>` : '';
  return `<a class="card" href="#/cat/${c.id}" style="text-decoration:none;display:block">
    <div class="row"><h3>${esc(c.name)}</h3><span class="spacer"></span><span class="chip ${cls}">${label}</span></div>
    <div class="small muted" style="margin-top:6px">${esc(c.formatGroups)}</div>${spots}</a>`;
}

function renderResults() {
  const el = $('#results');
  if (!el) return;
  const q = E.norm(searchQ);
  if (q.length < 3) { el.innerHTML = ''; return; }
  const teamIds = new Set(DATA.teams.filter((t) => E.norm(t.p1.name).includes(q) || E.norm(t.p2.name).includes(q)).map((t) => t.id));
  const ms = DATA.matches.filter((m) => teamIds.has(m.teamA) || teamIds.has(m.teamB));
  const teamsList = DATA.teams.filter((t) => teamIds.has(t.id));
  el.innerHTML = `<div class="section"><div class="section-head"><h2>Tus partidos</h2><span class="muted small">${teamsList.length} pareja(s) encontradas</span></div>
    ${teamsList.length ? `<div class="row small" style="margin-bottom:10px">${teamsList.map((t) => `<span class="chip">${esc(E.teamName(t))} · ${esc(C.cat(t.categoryId)?.name || '')}</span>`).join('')}</div>` : ''}
    ${teamsList.length ? matchesByDay(C, ms, { highlight: searchQ.trim(), emptyText: 'Tus partidos aparecerán aquí cuando se publique el rol de juegos.' }) : '<div class="card empty"><b>No encontramos ese nombre</b>Revisa la ortografía o busca por el nombre de tu pareja.</div>'}</div>`;
}

// ------------------------------------------------------------------
// Partidos (calendario general)
// ------------------------------------------------------------------
const filt = { cat: '', court: '', day: '', status: '' };
function viewPartidos() {
  const days = [...new Set(DATA.matches.filter((m) => m.time).map((m) => m.time.slice(0, 10)))].sort();
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  $('#app').innerHTML = `<div class="section-head"><h2>Calendario y resultados</h2></div>
    <div class="row no-print" style="margin-bottom:6px">
      <select id="fCat" style="max-width:200px">${opt('', 'Todas las categorías', filt.cat)}${DATA.categories.map((c) => opt(c.id, c.name, filt.cat)).join('')}</select>
      <select id="fCourt" style="max-width:160px">${opt('', 'Todas las pistas', filt.court)}${DATA.courts.map((c) => opt(c.id, c.name, filt.court)).join('')}</select>
      <select id="fDay" style="max-width:180px">${opt('', 'Todos los días', filt.day)}${days.map((d) => opt(d, fmtDay(d + 'T00:00'), filt.day)).join('')}</select>
      <select id="fStatus" style="max-width:170px">${opt('', 'Todos', filt.status)}${opt('next', 'Por jugar', filt.status)}${opt('live', 'En juego', filt.status)}${opt('done', 'Finalizados', filt.status)}</select>
    </div><div id="mlist"></div>`;
  const apply = () => {
    let ms = DATA.matches.filter((m) => m.status !== 'bye');
    if (filt.cat) ms = ms.filter((m) => m.categoryId === filt.cat);
    if (filt.court) ms = ms.filter((m) => m.court === filt.court);
    if (filt.day) ms = ms.filter((m) => m.time && m.time.startsWith(filt.day));
    if (filt.status === 'next') ms = ms.filter((m) => !E.isDone(m) && m.status !== 'playing');
    if (filt.status === 'live') ms = ms.filter((m) => m.status === 'playing' || m.status === 'called');
    if (filt.status === 'done') ms = ms.filter((m) => E.isDone(m));
    $('#mlist').innerHTML = matchesByDay(C, ms);
  };
  [['#fCat', 'cat'], ['#fCourt', 'court'], ['#fDay', 'day'], ['#fStatus', 'status']].forEach(([s, k]) =>
    $(s).addEventListener('change', (e) => { filt[k] = e.target.value; apply(); })
  );
  apply();
}

// ------------------------------------------------------------------
// Categorías
// ------------------------------------------------------------------
function viewCategorias() {
  $('#app').innerHTML = `<div class="section-head"><h2>Categorías</h2></div><div class="grid grid-3">${DATA.categories.map(catCard).join('') || '<div class="card empty"><b>Aún no hay categorías</b></div>'}</div>`;
}

function viewCat(id, tab) {
  const cat = C.cat(id);
  if (!cat) { location.hash = '#/categorias'; return; }
  const groups = DATA.groups.filter((g) => g.categoryId === id).sort((a, b) => a.name.localeCompare(b.name));
  const ko = DATA.matches.filter((m) => m.categoryId === id && (m.stage === 'ko' || m.stage === 'third'));
  const cons = DATA.matches.filter((m) => m.categoryId === id && m.stage === 'cons');
  const all = DATA.matches.filter((m) => m.categoryId === id && m.status !== 'bye');
  const tabs = [];
  if (groups.length) tabs.push(['grupos', 'Grupos']);
  tabs.push(['calendario', 'Calendario'], ['resultados', 'Resultados']);
  if (ko.length) tabs.push(['llave', 'Eliminatorias']);
  if (cons.length) tabs.push(['consolacion', 'Consolación']);
  tabs.push(['parejas', 'Parejas']);
  if (!tab || !tabs.some((t) => t[0] === tab)) tab = ko.length && cat.status !== 'groups' ? 'llave' : tabs[0][0];
  const champ = championsFrom(DATA, id);

  let body = '';
  if (tab === 'grupos') {
    body = `<p class="small muted">Clasifican ${cat.qualifyPerGroup} por grupo (sombreados). Formato: ${esc(cat.formatGroups)}.</p><div class="grid grid-2">${groups.map((g) => standingsTable(C, g, g.standings)).join('')}</div>
    ${groups.map((g) => `<div class="section"><h3 style="margin-bottom:8px">Partidos · Grupo ${esc(g.name)}</h3><div class="card list">${all.filter((m) => m.groupId === g.id).map((m) => matchRow(C, m, { showCat: false })).join('')}</div></div>`).join('')}`;
  } else if (tab === 'calendario') {
    body = matchesByDay(C, all.filter((m) => !E.isDone(m)), { showCat: false, emptyText: 'Todos los partidos ya se jugaron o aún no hay rol publicado.' });
  } else if (tab === 'resultados') {
    const done = all.filter((m) => E.isDone(m)).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    body = done.length ? `<div class="card list">${done.map((m) => matchRow(C, m, { showCat: false })).join('')}</div>` : '<div class="card empty"><b>Aún no hay resultados</b></div>';
  } else if (tab === 'llave') {
    body = `<p class="small muted">Formato: ${esc(cat.formatKo)}.</p>` + bracketHtml(C, ko);
  } else if (tab === 'consolacion') {
    body = bracketHtml(C, cons);
  } else if (tab === 'parejas') {
    const teams = DATA.teams.filter((t) => t.categoryId === id);
    body = teams.length ? `<div class="card"><table><thead><tr><th>#</th><th class="name">Pareja</th><th class="name">Club</th></tr></thead><tbody>${teams.map((t, i) => `<tr><td>${i + 1}</td><td class="name">${esc(E.teamName(t))}</td><td class="name muted">${esc([t.p1.club, t.p2.club].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / '))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty"><b>Aún no hay parejas confirmadas</b></div>';
  }
  $('#app').innerHTML = `<div class="section-head"><div><a href="#/categorias" class="small muted">← Categorías</a><h2>${esc(cat.name)}</h2></div><span class="chip ${(STATUS_CAT[cat.status] || [])[1]}">${(STATUS_CAT[cat.status] || [''])[0]}</span></div>
    ${champ ? podiumHtml(C, champ) : ''}
    <div class="tabs section">${tabs.map(([k, l]) => `<a href="#/cat/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>${body}`;
}

// ------------------------------------------------------------------
// Inscripciones
// ------------------------------------------------------------------
function viewInscripciones() {
  const t = DATA.tournament;
  const openCats = DATA.categories.filter((c) => c.status === 'registration');
  const deadlinePassed = t.deadline && new Date() > new Date(t.deadline + 'T23:59:59');
  if (!t.registrationOpen || deadlinePassed || !openCats.length) {
    $('#app').innerHTML = `<div class="card empty"><b>Las inscripciones están cerradas</b>${t.whatsapp ? `¿Dudas? <a href="https://wa.me/${esc(t.whatsapp)}" target="_blank" rel="noopener">Escríbenos por WhatsApp</a>` : ''}</div>`;
    return;
  }
  const player = (n) => `<div class="card"><h3 style="margin-bottom:10px">Jugador ${n}</h3><div class="form-grid">
      <div class="field"><label>Nombre completo *</label><input type="text" name="p${n}name" required minlength="3" maxlength="80" autocomplete="${n === 1 ? 'name' : 'off'}"></div>
      <div class="field"><label>Teléfono (WhatsApp) ${n === 1 ? '*' : ''}</label><input type="tel" name="p${n}phone" ${n === 1 ? 'required' : ''} inputmode="tel" pattern="[0-9 +\\-]{10,20}" placeholder="10 dígitos"></div>
      <div class="field"><label>Correo</label><input type="email" name="p${n}email"></div>
      <div class="field"><label>Ciudad</label><input type="text" name="p${n}city" maxlength="60"></div>
      <div class="field"><label>Club</label><input type="text" name="p${n}club" maxlength="60"></div>
    </div></div>`;
  $('#app').innerHTML = `<div class="section-head"><h2>Inscripciones</h2>${t.deadline ? `<span class="chip warn">Cierre: ${esc(fmtDayLong(t.deadline))}</span>` : ''}</div>
  <form id="regForm" class="grid" novalidate>
    <div id="regErr"></div>
    <div class="card"><div class="field"><label>Categoría *</label><select name="categoryId" id="catSel" required><option value="">Selecciona tu categoría</option>${openCats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div id="spotInfo" class="small muted"></div></div>
    ${player(1)}${player(2)}
    <div class="card">
      <div class="field"><label>Comentarios (opcional)</label><textarea name="notes" maxlength="300" placeholder="Disponibilidad de horario, etc."></textarea></div>
      ${t.fee ? `<p><b>Costo:</b> ${esc(t.fee)}</p>` : ''}
      ${t.rulesText ? `<details style="margin-bottom:12px"><summary style="cursor:pointer;font-weight:700">Reglamento</summary><p class="small" style="white-space:pre-line">${esc(t.rulesText)}</p></details>` : ''}
      <label class="check"><input type="checkbox" name="terms" required> Acepto el reglamento y confirmo que los datos son correctos.</label>
      <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div style="margin-top:14px"><button class="btn lg" type="submit" id="regBtn">Enviar inscripción</button></div>
    </div>
  </form>`;
  $('#catSel').addEventListener('change', updateSpots);
  $('#regForm').addEventListener('submit', submitReg);
}

function updateSpots() {
  const sel = $('#catSel');
  if (!sel) return;
  const c = C.cat(sel.value);
  const el = $('#spotInfo');
  if (!c) { el.textContent = ''; return; }
  const left = c.maxTeams - c.spotsTaken;
  el.innerHTML = `${esc(c.formatGroups)}<br>${c.fee ? `Costo: ${esc(c.fee)} · ` : ''}${left > 0 ? `<b>${left}</b> lugares disponibles de ${c.maxTeams}` : '<b style="color:var(--warn)">Categoría llena: tu pareja quedará en lista de espera.</b>'}`;
}

let sending = false;
async function submitReg(e) {
  e.preventDefault();
  if (sending) return;
  const f = e.target;
  const err = $('#regErr');
  err.innerHTML = '';
  if (!f.checkValidity()) {
    const bad = f.querySelector(':invalid');
    err.innerHTML = `<div class="alert">Revisa el campo: ${esc(bad?.closest('.field')?.querySelector('label')?.textContent || bad?.name || '')}${bad?.name === 'terms' ? 'Aceptar el reglamento' : ''}</div>`;
    bad?.focus();
    return;
  }
  const v = (n) => f.elements[n]?.value?.trim() || '';
  const body = {
    categoryId: v('categoryId'),
    p1: { name: v('p1name'), phone: v('p1phone'), email: v('p1email'), city: v('p1city'), club: v('p1club') },
    p2: { name: v('p2name'), phone: v('p2phone'), email: v('p2email'), city: v('p2city'), club: v('p2club') },
    notes: v('notes'),
    terms: f.elements.terms.checked,
    website: v('website'),
  };
  sending = true;
  $('#regBtn').disabled = true;
  $('#regBtn').textContent = 'Enviando…';
  try {
    const res = await fetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'No se pudo enviar.');
    const t = DATA.tournament;
    const cat = C.cat(body.categoryId);
    const wa = t.whatsapp ? `https://wa.me/${t.whatsapp}?text=${encodeURIComponent(`Hola, me inscribí al ${t.name}. Código: ${j.code}. Pareja: ${body.p1.name} / ${body.p2.name} (${cat?.name}).`)}` : '';
    $('#app').innerHTML = `<div class="card" style="max-width:620px;margin:0 auto;text-align:center;padding:30px 20px">
      <div style="font-size:48px">🎾</div><h2>¡Inscripción recibida!</h2>
      <p>${esc(body.p1.name)} / ${esc(body.p2.name)} · <b>${esc(cat?.name || '')}</b></p>
      <p>Tu código de inscripción es</p><div class="head" style="font-size:44px;color:var(--primary)">${esc(j.code)}</div>
      ${j.waitlist ? '<div class="alert info">La categoría está llena: quedaste en <b>lista de espera</b>. Te avisaremos si se libera un lugar.</div>' : '<p class="muted">Tu lugar queda confirmado cuando la mesa de control valide tu pago.</p>'}
      ${t.paymentInfo ? `<div class="card" style="text-align:left;background:#f7f9f8;box-shadow:none;margin:14px 0"><b>Instrucciones de pago</b><p class="small" style="white-space:pre-line;margin:6px 0 0">${esc(t.paymentInfo)}</p></div>` : ''}
      ${wa ? `<a class="btn accent lg" href="${wa}" target="_blank" rel="noopener">Enviar comprobante por WhatsApp</a>` : ''}
      <p style="margin-top:16px"><a href="#/">Volver al inicio</a></p></div>`;
    window.scrollTo(0, 0);
    fetchData(true);
  } catch (ex) {
    err.innerHTML = `<div class="alert">${esc(ex.message)}</div>`;
    err.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    sending = false;
    const b = $('#regBtn');
    if (b) { b.disabled = false; b.textContent = 'Enviar inscripción'; }
  }
}

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ------------------------------------------------------------------
// Vista "En vivo" para pantalla / TV
// ------------------------------------------------------------------
function viewTV() {
  const t = DATA.tournament;
  const now = new Date();
  const courts = DATA.courts.filter((c) => c.active);
  const pending = DATA.matches.filter((m) => !E.isDone(m) && m.status !== 'cancelled');
  const courtCards = courts
    .map((ct) => {
      const onCourt = pending.filter((m) => m.court === ct.id);
      const cur = onCourt.find((m) => m.status === 'playing') || onCourt.find((m) => m.status === 'called');
      const next = onCourt.filter((m) => m !== cur && m.time && m.status === 'scheduled').sort((a, b) => a.time.localeCompare(b.time)).slice(0, 2);
      return `<div class="tvcourt"><h3><span>${esc(ct.name)}</span>${cur ? (cur.status === 'playing' ? '<span class="chip live">En juego</span>' : '<span class="chip called">Llamado</span>') : '<span class="chip">Libre</span>'}</h3>
        ${cur ? `<div class="now">${esc(C.tname(cur.teamA))}<br><span class="muted small">vs</span><br>${esc(C.tname(cur.teamB))}<div class="small" style="color:#b9c9c2;font-weight:500">${esc(C.cat(cur.categoryId)?.name || '')} · ${esc(C.stageLabel(cur))}</div>${cur.sets?.length ? `<div class="sc">${esc(E.scoreText(cur))}</div>` : ''}</div>` : '<div class="now muted">—</div>'}
        ${next.map((m) => `<div class="next"><b>${m.time.slice(0, 10) === todayStr() ? '' : fmtDay(m.time) + ' '}${fmtTime(m.time)}</b> · ${esc(C.tname(m.teamA))} vs ${esc(C.tname(m.teamB))} <span class="small">(${esc(C.cat(m.categoryId)?.name || '')})</span></div>`).join('')}
      </div>`;
    })
    .join('');
  // Rotación de categorías en la parte inferior
  const slides = [];
  for (const c of DATA.categories) {
    const gs = DATA.groups.filter((g) => g.categoryId === c.id);
    const ko = DATA.matches.filter((m) => m.categoryId === c.id && (m.stage === 'ko' || m.stage === 'third'));
    if (ko.length && c.status !== 'groups') slides.push(`<h2 style="margin-bottom:10px">${esc(c.name)} · Eliminatorias</h2>${bracketHtml(C, ko)}`);
    else if (gs.length) slides.push(`<h2 style="margin-bottom:10px">${esc(c.name)} · Grupos</h2><div class="grid grid-2">${gs.map((g) => standingsTable(C, g, g.standings)).join('')}</div>`);
  }
  $('#app').innerHTML = `<div class="tvwrap"><div class="tvhead"><h1>${esc(t.name)}</h1><div style="text-align:right"><div class="head" style="font-size:40px" id="tvclock">${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</div><a href="#/" class="small muted">Salir</a></div></div>
    ${t.announcement ? `<div class="banner" style="display:block;border-radius:12px;margin-bottom:14px;padding:12px 16px">📣 ${esc(t.announcement)}</div>` : ''}
    <div class="tvcourts">${courtCards || '<div class="muted">Configura pistas en la mesa de control.</div>'}</div>
    <div class="tvbottom" id="tvslide"></div></div>`;
  const show = () => {
    if (!slides.length) return;
    tvIndex = tvIndex % slides.length;
    $('#tvslide').innerHTML = slides[tvIndex];
    tvIndex++;
  };
  show();
  tvTimer = setInterval(() => {
    show();
    const c = $('#tvclock');
    if (c) c.textContent = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }, 12000);
}

fetchData(true);
