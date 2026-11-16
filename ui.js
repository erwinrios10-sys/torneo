// Utilidades de interfaz compartidas (sitio público y mesa de control)
import { Engine as E } from './engine.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function parseLocal(t) {
  if (!t) return null;
  const [d, hm] = t.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = (hm || '00:00').split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi);
}
export const fmtTime = (t) => (t ? t.slice(11, 16) : '--:--');
export function fmtDay(t) {
  const d = parseLocal(t);
  if (!d) return 'Sin horario';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtDayLong(dateStr) {
  const d = parseLocal(dateStr + 'T00:00');
  const full = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const mon = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${full[d.getDay()]} ${d.getDate()} de ${mon[d.getMonth()]}`;
}

export function toast(msg, isErr = false, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function applyTheme(t) {
  const r = document.documentElement.style;
  if (t?.primary) {
    r.setProperty('--primary', t.primary);
    r.setProperty('--primary-2', shade(t.primary, 18));
  }
  if (t?.accent) r.setProperty('--accent', t.accent);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta && t?.primary) meta.content = t.primary;
}
function shade(hex, pct) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (v) => Math.min(255, Math.round(v + (255 - v) * (pct / 100)));
  return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---- Contexto de datos (sirve para estado completo o vista pública) ----
export function ctx(data) {
  const teams = new Map(data.teams.map((t) => [t.id, t]));
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  const groups = new Map(data.groups.map((g) => [g.id, g]));
  const courts = new Map(data.courts.map((c) => [c.id, c]));
  const roundsMax = {};
  for (const m of data.matches) {
    const k = m.categoryId + '|' + (m.stage === 'third' ? 'ko' : m.stage);
    roundsMax[k] = Math.max(roundsMax[k] || 0, m.round);
  }
  return {
    data,
    team: (id) => teams.get(id),
    tname: (id, fallback = 'Por definir') => (id && teams.get(id) ? E.teamName(teams.get(id)) : fallback),
    cat: (id) => cats.get(id),
    group: (id) => groups.get(id),
    court: (id) => (id && courts.get(id) ? courts.get(id).name : ''),
    stageLabel(m) {
      if (m.stage === 'group') return 'Grupo ' + (groups.get(m.groupId)?.name || '');
      if (m.stage === 'third') return '3er lugar';
      const total = roundsMax[m.categoryId + '|' + m.stage] || m.round;
      return (m.stage === 'cons' ? 'Consolación · ' : '') + E.roundName(total, m.round);
    },
  };
}

export function statusChip(m) {
  const map = {
    playing: ['live', 'En juego'],
    called: ['called', 'Llamado a pista'],
    finished: ['done', 'Final'],
    walkover: ['wo', 'W.O.'],
    retired: ['wo', 'Retiro'],
    postponed: ['warn', 'Pospuesto'],
    cancelled: ['bad', 'Cancelado'],
    bye: ['done', 'BYE'],
  };
  const v = map[m.status];
  return v ? `<span class="chip ${v[0]}">${v[1]}</span>` : '';
}

// Etiqueta de quién falta por definir en llaves
function pendingName(c, m, side) {
  const src = side === 'A' ? m.srcA : m.srcB;
  if (src?.type === 'bye') return 'BYE';
  if (src?.matchId) {
    const s = c.data.matches.find((x) => x.id === src.matchId);
    if (s) return `${src.type === 'loser' ? 'Perdedor' : 'Ganador'} ${c.stageLabel(s).replace('Cuartos de final', 'CF').replace('Semifinal', 'SF')} ${s.slot + 1}`;
  }
  return 'Por definir';
}

export function matchRow(c, m, opts = {}) {
  const done = E.isDone(m);
  const cls = (side) => (done && m.winner ? (m.winner === side ? 'win' : 'lose') : '');
  const cat = c.cat(m.categoryId);
  const hl = opts.highlight;
  const nA = m.teamA ? c.tname(m.teamA) : pendingName(c, m, 'A');
  const nB = m.teamB ? c.tname(m.teamB) : pendingName(c, m, 'B');
  const mark = (n) => (hl ? esc(n).replace(new RegExp(`(${hl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>') : esc(n));
  return `<div class="match ${m.status === 'playing' ? 'is-live' : ''}" data-id="${m.id}">
    <div class="when">${m.time ? fmtTime(m.time) : '—'}<small>${esc(c.court(m.court) || (m.time ? '' : 'Sin horario'))}</small></div>
    <div class="teams">
      <div class="team ${cls('A')}">${mark(nA)}</div>
      <div class="team ${cls('B')}">${mark(nB)}</div>
      <div class="label">${opts.showCat !== false && cat ? esc(cat.name) + ' · ' : ''}${esc(c.stageLabel(m))}${m.note ? ' · ' + esc(m.note) : ''}</div>
    </div>
    <div class="score">${statusChip(m)}<div>${esc(E.scoreText(m))}</div>${opts.action || ''}</div>
  </div>`;
}

export function matchesByDay(c, matches, opts = {}) {
  if (!matches.length) return `<div class="card empty"><b>No hay partidos</b>${opts.emptyText || ''}</div>`;
  const sorted = matches.slice().sort((a, b) => (a.time || '9999').localeCompare(b.time || '9999') || (c.court(a.court) || '').localeCompare(c.court(b.court) || '', 'es', { numeric: true }));
  let html = '';
  let day = null;
  for (const m of sorted) {
    const d = m.time ? m.time.slice(0, 10) : 'none';
    if (d !== day) {
      if (day !== null) html += '</div>';
      html += `<div class="card list section"><div class="daybar">${m.time ? fmtDay(m.time) : 'Por programar'}</div>`;
      day = d;
    }
    html += matchRow(c, m, opts);
  }
  return html + '</div>';
}

export function standingsTable(c, group, rows) {
  return `<div class="card"><div class="row" style="margin-bottom:6px"><h3>Grupo ${esc(group.name)}</h3></div>
  <div class="table-scroll"><table>
    <thead><tr><th>#</th><th class="name">Pareja</th><th title="Partidos jugados">PJ</th><th title="Ganados">PG</th><th title="Perdidos">PP</th><th class="c-g" title="Sets">Sets</th><th class="c-g" title="Games">Games</th><th title="Diferencia de games">Dif</th><th>Pts</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr class="${r.qualifies ? 'q' : ''}"><td>${r.pos}</td><td class="name">${esc(c.tname(r.teamId))}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td class="c-g">${r.setsW}-${r.setsL}</td><td class="c-g">${r.gamesW}-${r.gamesL}</td><td>${r.gamesW - r.gamesL > 0 ? '+' : ''}${r.gamesW - r.gamesL}</td><td class="pts">${r.points}</td></tr>`
      )
      .join('')}</tbody>
  </table></div></div>`;
}

export function bracketHtml(c, matches, opts = {}) {
  if (!matches.length) return '';
  const main = matches.filter((m) => m.stage !== 'third');
  const third = matches.find((m) => m.stage === 'third');
  const rounds = [...new Set(main.map((m) => m.round))].sort((a, b) => a - b);
  const card = (m) => {
    const done = E.isDone(m);
    const sc = (side) =>
      m.status === 'walkover' ? (m.winner === side ? 'W.O.' : '') : (m.sets || []).map((s) => (side === 'A' ? s[0] : s[1])).join(' ');
    const line = (side) => {
      const id = side === 'A' ? m.teamA : m.teamB;
      const name = id ? c.tname(id) : pendingName(c, m, side);
      return `<div class="bt ${id ? '' : 'tbd'} ${done && m.winner === side ? 'win' : ''}"><span>${esc(name)}</span><span class="s">${esc(sc(side))}</span></div>`;
    };
    const meta = m.status === 'bye' ? 'Avanza por BYE' : `${m.time ? fmtDay(m.time) + ' ' + fmtTime(m.time) : 'Por programar'}${m.court ? ' · ' + esc(c.court(m.court)) : ''}`;
    return `<div class="bmatch ${m.status === 'playing' ? 'live' : ''}" data-id="${m.id}" ${opts.clickable ? 'style="cursor:pointer"' : ''}>${line('A')}${line('B')}<div class="bm"><span>${meta}</span>${statusChip(m)}</div></div>`;
  };
  let html = '<div class="bracket">';
  for (const r of rounds) {
    const ms = main.filter((m) => m.round === r).sort((a, b) => a.slot - b.slot);
    html += `<div class="col"><h4>${esc(c.stageLabel(ms[0]))}</h4><div class="slots">${ms.map(card).join('')}</div></div>`;
  }
  if (third) html += `<div class="col"><h4>3er lugar</h4><div class="slots">${card(third)}</div></div>`;
  return html + '</div>';
}

export function podiumHtml(c, champ) {
  if (!champ) return '';
  return `<div class="card section"><h2 style="margin-bottom:14px">🏆 Campeones</h2><div class="podium">
    <div class="p second"><div class="medal">🥈</div><b>${esc(c.tname(champ.second))}</b><div class="small">Subcampeones</div></div>
    <div class="p first"><div class="medal">🥇</div><b>${esc(c.tname(champ.first))}</b><div class="small">Campeones</div></div>
    <div class="p third"><div class="medal">🥉</div><b>${champ.third ? esc(c.tname(champ.third)) : '—'}</b><div class="small">Tercer lugar</div></div>
  </div></div>`;
}

export function championsFrom(data, catId) {
  const ko = data.matches.filter((m) => m.categoryId === catId && m.stage === 'ko');
  if (!ko.length) return null;
  const maxR = Math.max(...ko.map((m) => m.round));
  const final = ko.find((m) => m.round === maxR);
  if (!final || !E.isDone(final) || !final.winner) return null;
  const third = data.matches.find((m) => m.categoryId === catId && m.stage === 'third');
  return {
    first: final.winner === 'A' ? final.teamA : final.teamB,
    second: final.winner === 'A' ? final.teamB : final.teamA,
    third: third && E.isDone(third) && third.winner ? (third.winner === 'A' ? third.teamA : third.teamB) : null,
  };
}
