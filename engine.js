// =====================================================================
// Motor del torneo de pádel (compartido por el sitio público, el panel
// /admin, las Netlify Functions y la mesa de control interna).
// Sin dependencias. Todas las funciones son puras o mutan el "state"
// que reciben de forma explícita.
// =====================================================================

const uid = (p = '') =>
  p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

const clone = (o) => JSON.parse(JSON.stringify(o));
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Barajado determinista opcional (para pruebas) o aleatorio.
function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------
// Valores por defecto
// ---------------------------------------------------------------------
const TIEBREAKERS = {
  points: 'Puntos',
  h2h: 'Resultado entre ellos',
  setDiff: 'Diferencia de sets',
  setsWon: 'Sets ganados',
  gameDiff: 'Diferencia de games',
  gamesWon: 'Games ganados',
  gamesLost: 'Menos games perdidos',
  draw: 'Sorteo (siembra / nombre)',
};

function defaultFormat() {
  return {
    type: 'bo3', // 'bo3' = mejor de 3 sets | 'oneSet' = un set largo / pro-set
    setGames: 6, // games para ganar un set (6, 9 para pro-set…)
    tiebreak: true, // tie-break al empatar en setGames-setGames
    superTB: true, // 3er set = súper tie-break a 10
    goldenPoint: true, // punto de oro (informativo)
  };
}

function defaultCategoryConfig() {
  return {
    groups: {
      mode: 'size', // 'size' (equipos por grupo) | 'count' (número de grupos)
      size: 4,
      count: 4,
      draw: 'seed', // 'seed' (serpentina por siembra) | 'random' | 'manual'
      avoidSameClub: true,
      qualifyPerGroup: 2,
      bestThirds: 0,
      points: { win: 2, loss: 1, woLoss: 0 },
      tiebreakers: ['points', 'h2h', 'setDiff', 'gameDiff', 'gamesWon', 'draw'],
    },
    groupFormat: defaultFormat(),
    koFormat: defaultFormat(),
    ko: {
      seeding: 'cross', // 'cross' | 'ranking' | 'random' | 'manual'
      avoidRematch: true,
      thirdPlace: false,
      consolation: false,
      autoGenerate: false,
    },
  };
}

function newTournament() {
  return {
    version: 0,
    updatedAt: new Date().toISOString(),
    tournament: {
      name: 'Mi Torneo de Pádel',
      subtitle: 'Partidos y resultados',
      dates: '',
      venue: '',
      address: '',
      logoUrl: '',
      primary: '#1F3D33',
      accent: '#C8F031',
      whatsapp: '',
      registrationOpen: true,
      deadline: '',
      fee: '',
      paymentInfo: '',
      rulesText: '',
      announcement: '',
      sponsors: [],
    },
    schedule: {
      days: [],
      slotMinutes: 75,
      restMinutes: 60,
    },
    courts: [
      { id: 'c1', name: 'Pista 1', active: true },
      { id: 'c2', name: 'Pista 2', active: true },
    ],
    categories: [],
    teams: [],
    groups: [],
    matches: [],
    log: [],
  };
}

function addCategory(state, name, opts = {}) {
  const cat = {
    id: uid('cat_'),
    name,
    maxTeams: opts.maxTeams || 16,
    fee: opts.fee || '',
    status: 'registration', // registration | groups | knockout | finished
    publish: { groups: false, ko: false },
    config: defaultCategoryConfig(),
  };
  state.categories.push(cat);
  return cat;
}

// ---------------------------------------------------------------------
// Equipos
// ---------------------------------------------------------------------
function teamName(team) {
  if (!team) return 'Por definir';
  const a = team.p1?.name || '?';
  const b = team.p2?.name || '?';
  return `${a} / ${b}`;
}

function teamClub(team) {
  const c1 = norm(team?.p1?.club);
  const c2 = norm(team?.p2?.club);
  return c1 || c2 || '';
}

function makeTeam(categoryId, p1, p2, extra = {}) {
  return {
    id: uid('t_'),
    categoryId,
    p1: { name: '', phone: '', email: '', city: '', club: '', ...p1 },
    p2: { name: '', phone: '', email: '', city: '', club: '', ...p2 },
    seed: null,
    status: 'pending', // pending | confirmed | waitlist | withdrawn
    paid: 'unpaid', // unpaid | partial | paid
    payRef: '',
    notes: '',
    code: Math.random().toString(36).slice(2, 7).toUpperCase(),
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

const activeTeams = (state, catId) =>
  state.teams.filter((t) => t.categoryId === catId && t.status === 'confirmed');

const occupiedSpots = (state, catId) =>
  state.teams.filter(
    (t) => t.categoryId === catId && (t.status === 'confirmed' || t.status === 'pending')
  ).length;

// ---------------------------------------------------------------------
// Validación de marcadores
// ---------------------------------------------------------------------
// Devuelve 'A' | 'B' si el set es válido y está terminado, o lanza Error.
function setWinner(a, b, fmt, isSuperTB) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0)
    throw new Error('Los games deben ser números enteros positivos.');
  const w = Math.max(a, b);
  const l = Math.min(a, b);
  const who = a > b ? 'A' : 'B';
  if (a === b) throw new Error(`Un set no puede quedar empatado (${a}-${b}).`);
  if (isSuperTB) {
    if (w < 10) throw new Error(`Súper tie-break incompleto (${a}-${b}): se juega a 10.`);
    if (w - l < 2) throw new Error(`Súper tie-break ${a}-${b}: se gana por 2 puntos.`);
    if (w > 10 && w - l !== 2)
      throw new Error(`Súper tie-break ${a}-${b} no es posible.`);
    return who;
  }
  const G = fmt.setGames || 6;
  if (w < G) throw new Error(`Set incompleto (${a}-${b}): se juega a ${G} games.`);
  if (fmt.type === 'oneSet') {
    // Pro-set: primero a G; con tie-break al llegar a (G-1)-(G-1) se termina G-(G-1)
    if (w === G && (l <= G - 2 || (fmt.tiebreak && l === G - 1))) return who;
    if (!fmt.tiebreak && w > G - 1 && w - l === 2) return who;
    throw new Error(`Set ${a}-${b} no es válido para un set a ${G}${fmt.tiebreak ? ' con tie-break' : ''}.`);
  }
  if (w === G) {
    if (w - l < 2) throw new Error(`Set ${a}-${b}: hay que ganar por 2 games.`);
    return who;
  }
  // w > G
  if (fmt.tiebreak) {
    if (w === G + 1 && (l === G - 1 || l === G)) return who;
    throw new Error(`Set ${a}-${b} no es válido (con tie-break el máximo es ${G + 1}-${G}).`);
  }
  if (w - l !== 2) throw new Error(`Set ${a}-${b} no es válido (sin tie-break se gana por 2).`);
  return who;
}

// Valida un marcador completo. sets: [[a,b],...]. Devuelve {winner}.
function validateScore(sets, fmt) {
  if (!Array.isArray(sets) || sets.length === 0) throw new Error('Captura al menos un set.');
  if (fmt.type === 'oneSet') {
    if (sets.length !== 1) throw new Error('Este formato se juega a un solo set.');
    return { winner: setWinner(sets[0][0], sets[0][1], fmt, false) };
  }
  // mejor de 3
  let wa = 0;
  let wb = 0;
  for (let i = 0; i < sets.length; i++) {
    if (wa === 2 || wb === 2) throw new Error('Hay sets de más: el partido ya estaba decidido.');
    const isSTB = i === 2 && fmt.superTB;
    const w = setWinner(sets[i][0], sets[i][1], fmt, isSTB);
    if (w === 'A') wa++;
    else wb++;
  }
  if (wa < 2 && wb < 2) throw new Error('El partido no está terminado: alguien debe ganar 2 sets.');
  return { winner: wa > wb ? 'A' : 'B' };
}

function formatFor(state, match) {
  const cat = state.categories.find((c) => c.id === match.categoryId);
  if (!cat) return defaultFormat();
  return match.stage === 'group' ? cat.config.groupFormat : cat.config.koFormat;
}

function formatLabel(fmt) {
  if (fmt.type === 'oneSet')
    return `1 set a ${fmt.setGames} games${fmt.tiebreak ? ` (tie-break en ${fmt.setGames - 1}-${fmt.setGames - 1})` : ''}${fmt.goldenPoint ? ' · punto de oro' : ''}`;
  return `Mejor de 3 sets a ${fmt.setGames}${fmt.tiebreak ? ' (tie-break)' : ''}${
    fmt.superTB ? ', 3º = súper tie-break' : ''
  }${fmt.goldenPoint ? ' · punto de oro' : ''}`;
}

function scoreText(m) {
  if (m.status === 'walkover') return 'W.O.';
  if (!m.sets || !m.sets.length) return '';
  const s = m.sets.map((x) => `${x[0]}-${x[1]}`).join('  ');
  return m.status === 'retired' ? `${s} (ret.)` : s;
}

// ---------------------------------------------------------------------
// Aplicar resultado (usado por servidor y mesa de control interna)
// payload: { status, sets, winner?, court?, time?, note? }
// ---------------------------------------------------------------------
function applyScore(state, matchId, payload, who = 'admin') {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) throw new Error('Partido no encontrado.');
  const before = clone(m);
  const fmt = formatFor(state, m);
  const p = payload || {};

  if ('court' in p) m.court = p.court || null;
  if ('time' in p) m.time = p.time || null;
  if ('note' in p) m.note = p.note || '';

  const status = p.status || m.status;
  if (['finished', 'walkover', 'retired'].includes(status)) {
    if (!m.teamA || !m.teamB) throw new Error('Aún no se conocen las dos parejas de este partido.');
  }

  if (status === 'finished') {
    const sets = (p.sets || []).map((s) => [Number(s[0]), Number(s[1])]);
    const { winner } = validateScore(sets, fmt);
    m.sets = sets;
    m.winner = winner;
  } else if (status === 'walkover') {
    if (p.winner !== 'A' && p.winner !== 'B') throw new Error('Indica qué pareja gana por W.O.');
    m.winner = p.winner;
    m.sets = [];
  } else if (status === 'retired') {
    if (p.winner !== 'A' && p.winner !== 'B') throw new Error('Indica qué pareja gana por retiro.');
    m.winner = p.winner;
    m.sets = (p.sets || [])
      .map((s) => [Number(s[0]), Number(s[1])])
      .filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]));
  } else {
    // scheduled | called | playing | postponed | cancelled
    if ('sets' in p && status !== 'scheduled') m.sets = p.sets || [];
    if (status === 'scheduled' || status === 'postponed' || status === 'cancelled') {
      if (p.clearResult !== false) {
        m.sets = [];
        m.winner = null;
      }
    }
  }
  m.status = status;
  m.updatedAt = new Date().toISOString();
  m.updatedBy = who;

  addLog(state, who, `${matchLabel(state, m)}: ${statusLabel(m.status)} ${scoreText(m)}`.trim(), {
    type: 'match',
    matchId,
    before,
  });
  propagate(state);
  maybeAutoBracket(state, m.categoryId);
  refreshCategoryStatus(state, m.categoryId);
  return m;
}

function undoLog(state, logId, who = 'admin') {
  const entry = state.log.find((l) => l.id === logId);
  if (!entry || entry.type !== 'match' || !entry.before) throw new Error('Este cambio no se puede deshacer.');
  const i = state.matches.findIndex((m) => m.id === entry.matchId);
  if (i < 0) throw new Error('El partido ya no existe.');
  state.matches[i] = entry.before;
  entry.undone = true;
  addLog(state, who, `Deshacer: ${matchLabel(state, entry.before)}`);
  propagate(state);
  refreshCategoryStatus(state, entry.before.categoryId);
}

function addLog(state, who, msg, extra = {}) {
  state.log = state.log || [];
  state.log.unshift({ id: uid('l_'), t: new Date().toISOString(), who, msg, ...extra });
  if (state.log.length > 150) state.log.length = 150;
}

const STATUS_LABELS = {
  scheduled: 'Programado',
  called: 'Llamado a pista',
  playing: 'En juego',
  finished: 'Finalizado',
  walkover: 'W.O.',
  retired: 'Retiro',
  postponed: 'Pospuesto',
  cancelled: 'Cancelado',
  bye: 'BYE',
};
const statusLabel = (s) => STATUS_LABELS[s] || s;
const isDone = (m) => ['finished', 'walkover', 'retired', 'bye'].includes(m.status);

// ---------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------
function groupLetter(i) {
  let s = '';
  i++;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// Devuelve una propuesta de grupos (no muta state): [{name, teamIds}]
function proposeGroups(state, catId, rnd = Math.random) {
  const cat = state.categories.find((c) => c.id === catId);
  const cfg = cat.config.groups;
  const teams = activeTeams(state, catId);
  const n = teams.length;
  if (n < 2) throw new Error('Se necesitan al menos 2 parejas confirmadas.');
  let count =
    cfg.mode === 'count'
      ? Math.max(1, Math.min(cfg.count || 1, Math.floor(n / 2)))
      : Math.max(1, Math.round(n / Math.max(2, cfg.size || 4)));
  count = Math.max(1, Math.min(count, Math.floor(n / 2)));

  let ordered;
  if (cfg.draw === 'random') ordered = shuffle(teams, rnd);
  else {
    const seeded = teams
      .filter((t) => Number.isFinite(t.seed) && t.seed > 0)
      .sort((a, b) => a.seed - b.seed);
    const rest = shuffle(
      teams.filter((t) => !(Number.isFinite(t.seed) && t.seed > 0)),
      rnd
    );
    ordered = seeded.concat(rest);
  }

  const groups = Array.from({ length: count }, (_, i) => ({ name: groupLetter(i), teamIds: [] }));
  // Serpentina por "bombos" de tamaño = count
  for (let tier = 0; tier * count < ordered.length; tier++) {
    let pot = ordered.slice(tier * count, tier * count + count);
    const orderIdx = Array.from({ length: count }, (_, i) => i);
    if (tier % 2 === 1 && cfg.draw !== 'random') orderIdx.reverse();
    for (const gi of orderIdx) {
      if (!pot.length) break;
      let pick = 0;
      if (cfg.avoidSameClub) {
        const clubs = new Set(
          groups[gi].teamIds
            .map((id) => teamClub(teams.find((t) => t.id === id)))
            .filter(Boolean)
        );
        const ok = pot.findIndex((t) => !teamClub(t) || !clubs.has(teamClub(t)));
        if (ok >= 0) pick = ok;
      }
      groups[gi].teamIds.push(pot[pick].id);
      pot = pot.filter((_, i) => i !== pick);
    }
  }
  return groups;
}

// Circle method: rondas de todos contra todos
function roundRobin(ids) {
  const list = ids.slice();
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

// Aplica grupos (borra grupos/partidos de grupo y llaves anteriores de la categoría)
function applyGroups(state, catId, groupsProposal, who = 'admin') {
  const cat = state.categories.find((c) => c.id === catId);
  state.groups = state.groups.filter((g) => g.categoryId !== catId);
  state.matches = state.matches.filter((m) => m.categoryId !== catId);
  for (const g of groupsProposal) {
    const group = { id: uid('g_'), categoryId: catId, name: g.name, teamIds: g.teamIds.slice() };
    state.groups.push(group);
    roundRobin(group.teamIds).forEach((pairs, r) => {
      pairs.forEach(([a, b], k) => {
        state.matches.push(newMatch(catId, 'group', { groupId: group.id, round: r + 1, slot: k, teamA: a, teamB: b }));
      });
    });
  }
  cat.status = 'groups';
  addLog(state, who, `${cat.name}: se generaron ${groupsProposal.length} grupos`);
}

function newMatch(categoryId, stage, extra) {
  return {
    id: uid('m_'),
    categoryId,
    stage, // group | ko | cons
    groupId: null,
    round: 1,
    slot: 0,
    teamA: null,
    teamB: null,
    srcA: null,
    srcB: null,
    court: null,
    time: null,
    status: 'scheduled',
    sets: [],
    winner: null,
    note: '',
    updatedAt: null,
    updatedBy: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------
// Tabla de posiciones con desempates configurables
// ---------------------------------------------------------------------
function emptyRow(teamId) {
  return { teamId, played: 0, won: 0, lost: 0, setsW: 0, setsL: 0, gamesW: 0, gamesL: 0, points: 0 };
}

function matchStats(m, fmt) {
  // Devuelve contribución para A y B: {setsA,setsB,gamesA,gamesB}
  let setsA = 0;
  let setsB = 0;
  let gamesA = 0;
  let gamesB = 0;
  if (m.status === 'walkover') {
    const nSets = fmt.type === 'oneSet' ? 1 : 2;
    const g = fmt.setGames || 6;
    if (m.winner === 'A') {
      setsA = nSets;
      gamesA = nSets * g;
    } else {
      setsB = nSets;
      gamesB = nSets * g;
    }
    return { setsA, setsB, gamesA, gamesB };
  }
  (m.sets || []).forEach((s, i) => {
    const isSTB = fmt.type !== 'oneSet' && i === 2 && fmt.superTB;
    if (s[0] > s[1]) setsA++;
    else if (s[1] > s[0]) setsB++;
    if (isSTB) {
      if (s[0] > s[1]) gamesA += 1;
      else gamesB += 1;
    } else {
      gamesA += s[0];
      gamesB += s[1];
    }
  });
  return { setsA, setsB, gamesA, gamesB };
}

function computeRows(state, groupMatches, teamIds, cfg, fmt) {
  const rows = Object.fromEntries(teamIds.map((id) => [id, emptyRow(id)]));
  for (const m of groupMatches) {
    if (!['finished', 'walkover', 'retired'].includes(m.status)) continue;
    const A = rows[m.teamA];
    const B = rows[m.teamB];
    if (!A || !B) continue;
    const st = matchStats(m, fmt);
    A.played++;
    B.played++;
    A.setsW += st.setsA;
    A.setsL += st.setsB;
    B.setsW += st.setsB;
    B.setsL += st.setsA;
    A.gamesW += st.gamesA;
    A.gamesL += st.gamesB;
    B.gamesW += st.gamesB;
    B.gamesL += st.gamesA;
    const winRow = m.winner === 'A' ? A : B;
    const loseRow = m.winner === 'A' ? B : A;
    winRow.won++;
    loseRow.lost++;
    winRow.points += cfg.points.win;
    loseRow.points += m.status === 'walkover' ? cfg.points.woLoss : cfg.points.loss;
  }
  return Object.values(rows);
}

function critValue(row, crit) {
  switch (crit) {
    case 'points':
      return row.points;
    case 'setDiff':
      return row.setsW - row.setsL;
    case 'setsWon':
      return row.setsW;
    case 'gameDiff':
      return row.gamesW - row.gamesL;
    case 'gamesWon':
      return row.gamesW;
    case 'gamesLost':
      return -row.gamesL;
    default:
      return 0;
  }
}

function rankRows(state, rows, groupMatches, cfg, fmt) {
  const teamById = (id) => state.teams.find((t) => t.id === id);
  const crits = cfg.tiebreakers && cfg.tiebreakers.length ? cfg.tiebreakers : ['points', 'draw'];

  function sortSubset(subset, ci) {
    if (subset.length <= 1 || ci >= crits.length) return subset;
    const crit = crits[ci];
    let valueOf;
    if (crit === 'h2h') {
      const ids = new Set(subset.map((r) => r.teamId));
      const mini = computeRows(
        state,
        groupMatches.filter((m) => ids.has(m.teamA) && ids.has(m.teamB)),
        [...ids],
        cfg,
        fmt
      );
      const map = Object.fromEntries(mini.map((r) => [r.teamId, r.points]));
      valueOf = (r) => map[r.teamId] || 0;
    } else if (crit === 'draw') {
      const key = (r) => {
        const t = teamById(r.teamId);
        const seed = Number.isFinite(t?.seed) && t.seed > 0 ? t.seed : 9999;
        return [seed, teamName(t)];
      };
      return subset.slice().sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
      });
    } else valueOf = (r) => critValue(r, crit);

    const buckets = new Map();
    for (const r of subset) {
      const v = valueOf(r);
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v).push(r);
    }
    const keys = [...buckets.keys()].sort((a, b) => b - a);
    const out = [];
    for (const k of keys) {
      const b = buckets.get(k);
      out.push(...(b.length === subset.length ? sortSubset(b, ci + 1) : sortSubset(b, 0)));
    }
    return out;
  }
  // Nota: al separar un empate en sub-bloques, cada sub-bloque se vuelve a
  // ordenar desde el primer criterio (regla habitual para enfrentamiento
  // directo entre los empatados restantes).
  return sortSubset(rows, 0);
}

function standings(state, groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return [];
  const cat = state.categories.find((c) => c.id === g.categoryId);
  const cfg = cat.config.groups;
  const fmt = cat.config.groupFormat;
  const gm = state.matches.filter((m) => m.groupId === groupId);
  const rows = computeRows(state, gm, g.teamIds, cfg, fmt);
  const ranked = rankRows(state, rows, gm, cfg, fmt);
  const q = cfg.qualifyPerGroup || 0;
  return ranked.map((r, i) => ({ ...r, pos: i + 1, qualifies: i < q }));
}

const groupComplete = (state, groupId) => {
  const ms = state.matches.filter((m) => m.groupId === groupId);
  return ms.length > 0 && ms.every(isDone);
};

const groupsComplete = (state, catId) => {
  const gs = state.groups.filter((g) => g.categoryId === catId);
  return gs.length > 0 && gs.every((g) => groupComplete(state, g.id));
};

// Clasificados en orden de siembra para la llave
function qualifiers(state, catId) {
  const cat = state.categories.find((c) => c.id === catId);
  const cfg = cat.config.groups;
  const gs = state.groups.filter((g) => g.categoryId === catId).sort((a, b) => a.name.localeCompare(b.name));
  const tables = gs.map((g) => ({ g, rows: standings(state, g.id) }));
  const q = cfg.qualifyPerGroup || 1;
  const byPos = [];
  const cmp = (a, b) =>
    b.points / Math.max(1, b.played) - a.points / Math.max(1, a.played) ||
    b.setsW - b.setsL - (a.setsW - a.setsL) ||
    b.gamesW - b.gamesL - (a.gamesW - a.gamesL);
  for (let p = 0; p < q; p++) {
    let tier = tables.filter((t) => t.rows[p]).map((t) => ({ ...t.rows[p], groupId: t.g.id, groupName: t.g.name }));
    if (cat.config.ko.seeding === 'ranking') tier = tier.sort(cmp);
    byPos.push(tier);
  }
  let list = byPos.flat();
  if (cfg.bestThirds > 0) {
    const extra = tables
      .filter((t) => t.rows[q])
      .map((t) => ({ ...t.rows[q], groupId: t.g.id, groupName: t.g.name }))
      .sort(cmp)
      .slice(0, cfg.bestThirds);
    list = list.concat(extra);
  }
  if (cat.config.ko.seeding === 'random') list = shuffle(list);
  const qualified = new Set(list.map((r) => r.teamId));
  const others = tables
    .flatMap((t) => t.rows.map((r) => ({ ...r, groupId: t.g.id, groupName: t.g.name })))
    .filter((r) => !qualified.has(r.teamId));
  return { qualified: list, eliminated: others };
}

// ---------------------------------------------------------------------
// Llaves (eliminación directa)
// ---------------------------------------------------------------------
function bracketOrder(size) {
  // Orden estándar de siembra: [1, size, ...]
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) next.push(s, n + 1 - s);
    order = next;
  }
  return order;
}

function roundName(roundsTotal, r) {
  const left = roundsTotal - r; // r empieza en 1
  if (left === 0) return 'Final';
  if (left === 1) return 'Semifinal';
  if (left === 2) return 'Cuartos de final';
  if (left === 3) return 'Octavos de final';
  return `Ronda de ${2 ** (left + 1)}`;
}

// entries: [{teamId, groupId?}] en orden de siembra
function buildBracket(state, catId, stage, entries, opts = {}) {
  state.matches = state.matches.filter((m) => !(m.categoryId === catId && (m.stage === stage || (stage === 'ko' && m.stage === 'third'))));
  const n = entries.length;
  if (n < 2) throw new Error('Se necesitan al menos 2 parejas para una llave.');
  let size = 2;
  while (size < n) size *= 2;
  const rounds = Math.log2(size);
  const order = bracketOrder(size);
  const slots = order.map((seed) => entries[seed - 1] || null); // null = BYE

  // Evitar revancha de grupo en 1ª ronda: intercambiar con otro partido
  if (opts.avoidRematch) {
    for (let i = 0; i < size; i += 2) {
      const a = slots[i];
      const b = slots[i + 1];
      if (a && b && a.groupId && a.groupId === b.groupId) {
        for (let j = 0; j < size; j += 2) {
          if (j === i) continue;
          const c = slots[j];
          const d = slots[j + 1];
          // cambiamos b por d (ambos "segundos" del cruce)
          if (d && c && d.groupId !== a.groupId && c.groupId !== b.groupId) {
            slots[i + 1] = d;
            slots[j + 1] = b;
            break;
          }
        }
      }
    }
  }

  const byRound = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    const arr = [];
    for (let s = 0; s < count; s++) {
      const m = newMatch(catId, stage, { round: r, slot: s });
      if (r === 1) {
        const a = slots[2 * s];
        const b = slots[2 * s + 1];
        m.teamA = a ? a.teamId : null;
        m.teamB = b ? b.teamId : null;
        m.srcA = a ? { type: 'team' } : { type: 'bye' };
        m.srcB = b ? { type: 'team' } : { type: 'bye' };
      } else {
        m.srcA = { type: 'winner', matchId: byRound[r - 2][2 * s].id };
        m.srcB = { type: 'winner', matchId: byRound[r - 2][2 * s + 1].id };
      }
      arr.push(m);
    }
    byRound.push(arr);
  }
  const all = byRound.flat();
  if (opts.thirdPlace && rounds >= 2) {
    const semis = byRound[rounds - 2];
    all.push(
      newMatch(catId, 'third', {
        round: rounds,
        slot: 1,
        srcA: { type: 'loser', matchId: semis[0].id },
        srcB: { type: 'loser', matchId: semis[1].id },
      })
    );
  }
  state.matches.push(...all);
  propagate(state);
  return all;
}

function generateKnockout(state, catId, who = 'admin', manualEntries = null) {
  const cat = state.categories.find((c) => c.id === catId);
  const ko = cat.config.ko;
  const hasGroups = state.groups.some((g) => g.categoryId === catId);
  let entries;
  let eliminated = [];
  if (manualEntries) entries = manualEntries.map((id) => ({ teamId: id }));
  else if (hasGroups) {
    const q = qualifiers(state, catId);
    entries = q.qualified.map((r) => ({ teamId: r.teamId, groupId: r.groupId }));
    eliminated = q.eliminated;
  } else {
    // Llave directa sin grupos: por siembra
    const teams = activeTeams(state, catId);
    const seeded = teams.filter((t) => t.seed > 0).sort((a, b) => a.seed - b.seed);
    const rest = shuffle(teams.filter((t) => !(t.seed > 0)));
    entries = seeded.concat(rest).map((t) => ({ teamId: t.id }));
  }
  buildBracket(state, catId, 'ko', entries, { avoidRematch: ko.avoidRematch && !manualEntries, thirdPlace: ko.thirdPlace });
  if (ko.consolation && eliminated.length >= 2) {
    buildBracket(state, catId, 'cons', eliminated.map((r) => ({ teamId: r.teamId, groupId: r.groupId })), {
      avoidRematch: ko.avoidRematch,
    });
  } else {
    state.matches = state.matches.filter((m) => !(m.categoryId === catId && m.stage === 'cons'));
  }
  cat.status = 'knockout';
  addLog(state, who, `${cat.name}: se generó la llave (${entries.length} parejas)`);
}

function maybeAutoBracket(state, catId) {
  const cat = state.categories.find((c) => c.id === catId);
  if (!cat || !cat.config.ko.autoGenerate) return;
  const hasKo = state.matches.some((m) => m.categoryId === catId && m.stage === 'ko');
  if (!hasKo && groupsComplete(state, catId)) generateKnockout(state, catId, 'sistema');
}

// Recalcula equipos de partidos que dependen de otros, BYEs y avance
function propagate(state) {
  const byId = new Map(state.matches.map((m) => [m.id, m]));
  const resolve = (src) => {
    if (!src) return { team: undefined };
    if (src.type === 'bye') return { team: null, bye: true };
    if (src.type === 'team') return { team: undefined };
    const s = byId.get(src.matchId);
    if (!s || !isDone(s) || !s.winner) return { team: null };
    const winner = s.winner === 'A' ? s.teamA : s.teamB;
    const loser = s.winner === 'A' ? s.teamB : s.teamA;
    return { team: src.type === 'winner' ? winner : loser, fromBye: s.status === 'bye' && src.type === 'loser' };
  };
  // Itera por rondas en orden
  const ko = state.matches
    .filter((m) => m.stage !== 'group')
    .sort((a, b) => a.round - b.round || (a.stage === 'third') - (b.stage === 'third'));
  for (const m of ko) {
    const ra = resolve(m.srcA);
    const rb = resolve(m.srcB);
    const newA = ra.team === undefined ? m.teamA : ra.team;
    const newB = rb.team === undefined ? m.teamB : rb.team;
    if (newA !== m.teamA || newB !== m.teamB) {
      // si cambió quién juega y ya había resultado, se limpia
      if (isDone(m) && m.status !== 'bye') {
        m.sets = [];
        m.winner = null;
        m.status = 'scheduled';
      }
      m.teamA = newA;
      m.teamB = newB;
    }
    const aBye = m.srcA?.type === 'bye';
    const bBye = m.srcB?.type === 'bye';
    if ((aBye && m.teamB) || (bBye && m.teamA)) {
      m.status = 'bye';
      m.winner = aBye ? 'B' : 'A';
      m.sets = [];
    } else if (m.status === 'bye') {
      m.status = 'scheduled';
      m.winner = null;
    }
  }
}
function refreshCategoryStatus(state, catId) {
  const cat = state.categories.find((c) => c.id === catId);
  if (!cat) return;
  const ko = state.matches.filter((m) => m.categoryId === catId && m.stage === 'ko');
  if (!ko.length) {
    if (cat.status === 'finished' || cat.status === 'knockout') cat.status = state.groups.some((g) => g.categoryId === catId) ? 'groups' : 'registration';
    return;
  }
  const maxR = Math.max(...ko.map((m) => m.round));
  const final = ko.find((m) => m.round === maxR);
  cat.status = final && isDone(final) ? 'finished' : 'knockout';
}

function champions(state, catId) {
  const ko = state.matches.filter((m) => m.categoryId === catId && m.stage === 'ko');
  if (!ko.length) return null;
  const maxR = Math.max(...ko.map((m) => m.round));
  const final = ko.find((m) => m.round === maxR);
  if (!final || !isDone(final) || !final.winner) return null;
  const third = state.matches.find((m) => m.categoryId === catId && m.stage === 'third');
  return {
    first: final.winner === 'A' ? final.teamA : final.teamB,
    second: final.winner === 'A' ? final.teamB : final.teamA,
    third: third && isDone(third) ? (third.winner === 'A' ? third.teamA : third.teamB) : null,
  };
}

function matchLabel(state, m) {
  const cat = state.categories.find((c) => c.id === m.categoryId);
  let stage = '';
  if (m.stage === 'group') {
    const g = state.groups.find((x) => x.id === m.groupId);
    stage = `Grupo ${g ? g.name : ''}`;
  } else if (m.stage === 'third') stage = '3er lugar';
  else {
    const total = Math.max(...state.matches.filter((x) => x.categoryId === m.categoryId && x.stage === m.stage).map((x) => x.round));
    stage = (m.stage === 'cons' ? 'Consolación · ' : '') + roundName(total, m.round);
  }
  return `${cat ? cat.name : ''} · ${stage}`;
}

// ---------------------------------------------------------------------
// Calendario automático
// ---------------------------------------------------------------------
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
};
const pad = (n) => String(n).padStart(2, '0');
const slotStr = (date, min) => `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const timeToAbs = (t) => (t ? Date.parse(t + ':00Z') / 60000 : null);

// mode: 'unscheduled' (solo sin horario) | 'all' (re-programa todo lo no jugado)
function autoSchedule(state, opts = {}) {
  const mode = opts.mode || 'unscheduled';
  const catIds = opts.categoryIds || state.categories.map((c) => c.id);
  const sch = state.schedule;
  const dur = Number(sch.slotMinutes) || 75;
  const rest = Number(sch.restMinutes) || 0;
  const courts = state.courts.filter((c) => c.active);
  if (!courts.length) throw new Error('No hay pistas activas.');
  if (!sch.days || !sch.days.length) throw new Error('Configura al menos un día de juego (fecha, hora inicio y fin).');

  const pending = state.matches.filter(
    (m) => catIds.includes(m.categoryId) && !isDone(m) && m.status !== 'cancelled' && m.status !== 'playing' && (mode === 'all' || !m.time)
  );
  if (mode === 'all') pending.forEach((m) => { m.time = null; m.court = null; });

  // Jugadores (por nombre normalizado) para evitar choques entre categorías
  const playersOf = (teamId) => {
    const t = state.teams.find((x) => x.id === teamId);
    return t ? [norm(t.p1.name), norm(t.p2.name)].filter(Boolean) : [];
  };
  const busyUntil = new Map(); // jugador -> minuto absoluto en que queda libre (incluye descanso)
  const matchEnd = new Map(); // matchId -> fin absoluto
  const occupied = new Set(); // `${time}|${court}`
  for (const m of state.matches) {
    if (!m.time) continue;
    const st = timeToAbs(m.time);
    matchEnd.set(m.id, st + dur);
    if (m.court) occupied.add(`${m.time}|${m.court}`);
    for (const id of [m.teamA, m.teamB]) for (const p of playersOf(id)) busyUntil.set(p, Math.max(busyUntil.get(p) || 0, st + dur + rest));
  }

  const stageRank = { group: 0, ko: 1, cons: 1, third: 2 };
  const queue = pending.sort((a, b) => stageRank[a.stage] - stageRank[b.stage] || a.round - b.round || a.slot - b.slot);
  const slots = [];
  for (const d of sch.days) {
    const s = toMin(d.start);
    const e = toMin(d.end);
    for (let t = s; t + dur <= e; t += dur) slots.push(slotStr(d.date, t));
  }
  slots.sort();
  const depsOf = (m) => [m.srcA, m.srcB].filter((s) => s && s.matchId).map((s) => s.matchId);
  let placed = 0;
  for (const slot of slots) {
    const abs = timeToAbs(slot);
    for (const c of courts) {
      if (occupied.has(`${slot}|${c.id}`)) continue;
      const idx = queue.findIndex((m) => {
        const ps = [...playersOf(m.teamA), ...playersOf(m.teamB)];
        if (ps.some((p) => (busyUntil.get(p) || 0) > abs)) return false;
        // los partidos previos de la llave deben terminar antes
        for (const dep of depsOf(m)) {
          const end = matchEnd.get(dep);
          const depM = state.matches.find((x) => x.id === dep);
          if (depM && depM.status === 'bye') continue;
          if (end == null || end + rest > abs) return false;
        }
        return true;
      });
      if (idx < 0) continue;
      const m = queue.splice(idx, 1)[0];
      m.time = slot;
      m.court = c.id;
      occupied.add(`${slot}|${c.id}`);
      matchEnd.set(m.id, abs + dur);
      for (const id of [m.teamA, m.teamB]) for (const p of playersOf(id)) busyUntil.set(p, abs + dur + rest);
      placed++;
    }
    if (!queue.length) break;
  }
  // BYEs no necesitan horario
  return { placed, unplaced: queue.filter((m) => m.status !== 'bye').length };
}

// ---------------------------------------------------------------------
// Vista pública (sin datos privados)
// ---------------------------------------------------------------------
function publicView(state) {
  const pubCats = state.categories.map((c) => ({
    id: c.id,
    name: c.name,
    maxTeams: c.maxTeams,
    fee: c.fee,
    status: c.status,
    publish: c.publish,
    spotsTaken: occupiedSpots(state, c.id),
    formatGroups: formatLabel(c.config.groupFormat),
    formatKo: formatLabel(c.config.koFormat),
    qualifyPerGroup: c.config.groups.qualifyPerGroup,
  }));
  const visibleGroupCats = new Set(state.categories.filter((c) => c.publish?.groups).map((c) => c.id));
  const visibleKoCats = new Set(state.categories.filter((c) => c.publish?.ko).map((c) => c.id));
  const matches = state.matches.filter((m) =>
    m.stage === 'group' ? visibleGroupCats.has(m.categoryId) : visibleKoCats.has(m.categoryId)
  );
  const teamIds = new Set();
  matches.forEach((m) => { if (m.teamA) teamIds.add(m.teamA); if (m.teamB) teamIds.add(m.teamB); });
  state.groups.filter((g) => visibleGroupCats.has(g.categoryId)).forEach((g) => g.teamIds.forEach((id) => teamIds.add(id)));
  state.teams.filter((t) => t.status === 'confirmed').forEach((t) => teamIds.add(t.id));
  const teams = state.teams
    .filter((t) => teamIds.has(t.id))
    .map((t) => ({
      id: t.id,
      categoryId: t.categoryId,
      p1: { name: t.p1.name, club: t.p1.club || '' },
      p2: { name: t.p2.name, club: t.p2.club || '' },
      seed: t.seed || null,
    }));
  const t = state.tournament;
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    tournament: {
      name: t.name, subtitle: t.subtitle, dates: t.dates, venue: t.venue, address: t.address,
      logoUrl: t.logoUrl, primary: t.primary, accent: t.accent, whatsapp: t.whatsapp,
      registrationOpen: t.registrationOpen, deadline: t.deadline, fee: t.fee,
      paymentInfo: t.paymentInfo, rulesText: t.rulesText, announcement: t.announcement, sponsors: t.sponsors || [],
    },
    courts: state.courts,
    days: (state.schedule && state.schedule.days) || [],
    categories: pubCats,
    teams,
    groups: state.groups.filter((g) => visibleGroupCats.has(g.categoryId)).map((g) => ({ ...g, standings: standings(state, g.id) })),
    matches: matches.map(({ updatedBy, note, ...m }) => ({ ...m, note: note || '' })),
  };
}

function registrationOpenFor(state, catId, now = new Date()) {
  const t = state.tournament;
  if (!t.registrationOpen) return { open: false, reason: 'Las inscripciones están cerradas.' };
  if (t.deadline && now > new Date(t.deadline + 'T23:59:59')) return { open: false, reason: 'La fecha límite de inscripción ya pasó.' };
  const cat = state.categories.find((c) => c.id === catId);
  if (!cat) return { open: false, reason: 'Categoría no válida.' };
  if (cat.status !== 'registration') return { open: false, reason: 'Esta categoría ya cerró inscripciones.' };
  const full = occupiedSpots(state, catId) >= (cat.maxTeams || 999);
  return { open: true, full };
}

// ---------------------------------------------------------------------
// Datos de demostración
// ---------------------------------------------------------------------
const DEMO_NAMES = ['Luis', 'Ana', 'Carlos', 'Sofía', 'Diego', 'Valeria', 'Jorge', 'Paola', 'Andrés', 'Mariana', 'Ricardo', 'Fernanda', 'Pablo', 'Daniela', 'Héctor', 'Camila', 'Iván', 'Regina', 'Óscar', 'Lucía', 'Raúl', 'Ximena', 'Tomás', 'Renata', 'Emilio', 'Natalia', 'Mauricio', 'Andrea', 'Rodrigo', 'Gabriela', 'Arturo', 'Karla'];
const DEMO_LAST = ['García', 'López', 'Martínez', 'Hernández', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Díaz', 'Cruz', 'Morales', 'Reyes', 'Ortiz', 'Castillo', 'Mendoza'];
const DEMO_CLUBS = ['Carbono Padel', 'Club Colima', 'Padel Manzanillo', 'Smash Club', ''];

function demoTournament(today = new Date()) {
  const s = newTournament();
  const d0 = new Date(today.getTime() + 5 * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const d1 = new Date(d0.getTime() + 864e5);
  Object.assign(s.tournament, {
    name: 'Open de Pádel Demo',
    subtitle: 'Partidos y resultados',
    dates: `${d0.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })} y ${d1.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })}`,
    venue: 'Club de Pádel Demo',
    address: 'Av. Ejemplo 123, Colima',
    whatsapp: '5213120000000',
    fee: '$1,200 por pareja',
    paymentInfo: 'Transferencia a la cuenta del club. Envía tu comprobante por WhatsApp con tu código de inscripción.',
    rulesText: 'Partidos al mejor de 3 sets con punto de oro. Tolerancia de 10 minutos; después se declara W.O.',
    announcement: 'Bienvenidos. Revisen su horario en "Busca tus partidos".',
    deadline: iso(new Date(today.getTime() + 3 * 864e5)),
    sponsors: [{ name: 'Patrocinador 1', url: '', logo: '' }, { name: 'Patrocinador 2', url: '', logo: '' }],
  });
  s.schedule.days = [
    { date: iso(d0), start: '08:00', end: '22:00' },
    { date: iso(d1), start: '08:00', end: '20:00' },
  ];
  s.courts = [1, 2, 3, 4].map((i) => ({ id: 'c' + i, name: 'Pista ' + i, active: true }));
  let k = 0;
  const person = () => {
    const n = `${DEMO_NAMES[k % DEMO_NAMES.length]} ${DEMO_LAST[(k * 5 + Math.floor(k / DEMO_NAMES.length)) % DEMO_LAST.length]}`;
    const club = DEMO_CLUBS[k % DEMO_CLUBS.length];
    k++;
    return { name: n, phone: '312' + String(1000000 + k * 7919).slice(0, 7), email: `jugador${k}@ejemplo.com`, city: 'Colima', club };
  };
  const cats = [addCategory(s, 'Varonil 2da', { maxTeams: 16 }), addCategory(s, 'Femenil 3ra', { maxTeams: 12 }), addCategory(s, 'Mixto B', { maxTeams: 8 })];
  cats[1].config.ko.thirdPlace = true;
  const counts = [12, 9, 8];
  cats.forEach((c, ci) => {
    for (let i = 0; i < counts[ci]; i++) {
      const t = makeTeam(c.id, person(), person(), { status: 'confirmed', paid: i % 4 === 0 ? 'unpaid' : 'paid', seed: i < 4 ? i + 1 : null });
      s.teams.push(t);
    }
  });
  // dos inscripciones pendientes
  s.teams.push(makeTeam(cats[0].id, person(), person()));
  s.teams.push(makeTeam(cats[2].id, person(), person()));

  // Grupos generados y publicados en dos categorías
  for (const c of cats.slice(0, 2)) {
    c.config.groups.size = c === cats[1] ? 3 : 4;
    applyGroups(s, c.id, proposeGroups(s, c.id), 'demo');
    c.publish.groups = true;
    c.publish.ko = true;
  }
  autoSchedule(s);
  // Algunos resultados
  const rnd = (() => { let x = 7; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
  const gm = s.matches.filter((m) => m.categoryId === cats[0].id).slice(0, 10);
  gm.forEach((m, i) => {
    const sets = i % 3 === 0 ? [[6, 4], [3, 6], [10, 7]] : rnd() > 0.5 ? [[6, 3], [6, 4]] : [[4, 6], [7, 6], [6, 10]];
    try { applyScore(s, m.id, { status: 'finished', sets }, 'demo'); } catch (e) { /* ignore */ }
  });
  // Femenil: todos los grupos completos -> llave
  s.matches.filter((m) => m.categoryId === cats[1].id && m.stage === 'group').forEach((m, i) => {
    applyScore(s, m.id, { status: 'finished', sets: i % 2 ? [[6, 2], [6, 2]] : [[2, 6], [6, 4], [10, 5]] }, 'demo');
  });
  generateKnockout(s, cats[1].id, 'demo');
  autoSchedule(s);
  const inPlay = s.matches.find((m) => m.categoryId === cats[0].id && m.status === 'scheduled');
  if (inPlay) inPlay.status = 'playing';
  s.log = [];
  addLog(s, 'demo', 'Torneo de demostración creado');
  return s;
}

export const Engine = {
  uid, clone, norm, shuffle,
  TIEBREAKERS, STATUS_LABELS,
  defaultFormat, defaultCategoryConfig, newTournament, addCategory,
  teamName, teamClub, makeTeam, activeTeams, occupiedSpots,
  setWinner, validateScore, formatFor, formatLabel, scoreText,
  applyScore, undoLog, addLog, statusLabel, isDone,
  groupLetter, proposeGroups, roundRobin, applyGroups,
  standings, groupComplete, groupsComplete, qualifiers,
  bracketOrder, roundName, buildBracket, generateKnockout, propagate,
  refreshCategoryStatus, champions, matchLabel,
  autoSchedule, publicView, registrationOpenFor, demoTournament,
};
export default Engine;
