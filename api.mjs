// =====================================================================
// API del torneo (Netlify Functions v2 + Netlify Blobs)
// Rutas:
//   GET  /api/public?v=N          datos públicos (sin teléfonos/correos/pagos)
//   POST /api/register            inscripción pública
//   POST /api/login | /api/logout ; GET /api/me
//   GET  /api/admin/state         estado completo (admin / capturista)
//   POST /api/admin/save          guarda estado completo (solo admin)
//   POST /api/admin/score         captura de resultado (admin / capturista)
//   POST /api/admin/undo          deshacer un cambio de partido (admin)
//   GET  /api/admin/history       versiones guardadas (admin)
//   POST /api/admin/restore       restaurar una versión (admin)
//   POST /api/admin/demo          cargar datos de demostración (admin)
// =====================================================================
import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Engine as E } from '../../public/js/engine.js';

const STORE = 'torneo';
const HISTORY_KEEP = 40;
const SESSION_HOURS = 12;
const MAX_BODY = 2_000_000;

const store = () => getStore({ name: STORE, consistency: 'strong' });

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('Solicitud demasiado grande.'), { status: 413 });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { status: 400 });
  }
}

// ---------------- Estado ----------------
async function loadState() {
  const s = await store().get('state', { type: 'json' });
  return s || E.newTournament();
}

async function saveState(state, prevVersion) {
  const st = store();
  const current = await st.get('state', { type: 'json' });
  if (current) {
    await st.setJSON(`history/${String(current.version).padStart(8, '0')}`, current);
  }
  state.version = (prevVersion ?? state.version ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  await st.setJSON('state', state);
  await st.setJSON('meta', { version: state.version, updatedAt: state.updatedAt });
  // poda del historial
  const { blobs } = await st.list({ prefix: 'history/' });
  const keys = blobs.map((b) => b.key).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - HISTORY_KEEP))) await st.delete(k);
  return state;
}

// ---------------- Sesión ----------------
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw Object.assign(new Error('Falta configurar SESSION_SECRET (mínimo 16 caracteres).'), { status: 500 });
  return s;
}
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

function makeSession(role) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function getSession(req) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)mc_session=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

const cookieHeader = (value, maxAge) =>
  `mc_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Bloqueo tras 5 intentos fallidos durante 15 min
async function checkLock(ip) {
  const rec = await store().get(`auth/${ip}`, { type: 'json' });
  if (rec && rec.until && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 60000);
  return 0;
}
async function registerFail(ip) {
  const st = store();
  const rec = (await st.get(`auth/${ip}`, { type: 'json' })) || { fails: 0 };
  rec.fails = (rec.until && rec.until < Date.now() ? 0 : rec.fails) + 1;
  rec.until = rec.fails >= 5 ? Date.now() + 15 * 60000 : 0;
  await st.setJSON(`auth/${ip}`, rec);
}

// Límite simple de inscripciones por IP: 10 por hora
async function rateLimit(ip, key, max, windowMs) {
  const st = store();
  const k = `rl/${key}/${ip}`;
  const rec = (await st.get(k, { type: 'json' })) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > windowMs) {
    rec.n = 0;
    rec.t = Date.now();
  }
  rec.n++;
  await st.setJSON(k, rec);
  return rec.n <= max;
}

// Inscripciones públicas: se guardan aparte y se integran al abrir el panel
async function absorbRegistrations(state) {
  const st = store();
  const { blobs } = await st.list({ prefix: 'reg/' });
  if (!blobs.length) return false;
  for (const b of blobs) {
    const reg = await st.get(b.key, { type: 'json' });
    if (reg && !state.teams.some((t) => t.id === reg.id)) {
      const cat = state.categories.find((c) => c.id === reg.categoryId);
      const full = cat && E.occupiedSpots(state, cat.id) >= (cat.maxTeams || 999);
      state.teams.push({ ...reg, status: full ? 'waitlist' : 'pending' });
      E.addLog(state, 'web', `Nueva inscripción: ${E.teamName(reg)} (${cat ? cat.name : '?'})`);
    }
  }
  return blobs.map((b) => b.key);
}

const stripPrivate = (state) => ({
  ...state,
  teams: state.teams.map((t) => ({
    ...t,
    p1: { name: t.p1.name, club: t.p1.club },
    p2: { name: t.p2.name, club: t.p2.club },
    payRef: '',
    notes: '',
  })),
});

const clean = (v, max = 120) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);

// ---------------- Router ----------------
export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'local';

  try {
    // ---------- Público ----------
    if (path === '/api/public' && method === 'GET') {
      const v = Number(url.searchParams.get('v'));
      const meta = await store().get('meta', { type: 'json' });
      if (meta && Number.isFinite(v) && v === meta.version) return json({ changed: false, version: v });
      const state = await loadState();
      const pending = (await store().list({ prefix: 'reg/' })).blobs;
      const pub = E.publicView(state);
      // Contar inscripciones aún no revisadas en el cupo
      for (const b of pending) {
        const catId = b.key.split('/')[1];
        const c = pub.categories.find((x) => x.id === catId);
        if (c) c.spotsTaken++;
      }
      return json({ changed: true, ...pub });
    }

    if (path === '/api/register' && method === 'POST') {
      const body = await readBody(req);
      if (body.website) return json({ ok: true, code: 'OK' }); // honeypot: bots
      if (!(await rateLimit(ip, 'reg', 10, 3600e3))) return fail('Demasiadas inscripciones desde esta conexión. Intenta más tarde.', 429);
      const state = await loadState();
      const ro = E.registrationOpenFor(state, body.categoryId);
      if (!ro.open) return fail(ro.reason);
      const p = (x) => ({
        name: clean(x?.name, 80),
        phone: clean(x?.phone, 20),
        email: clean(x?.email, 100),
        city: clean(x?.city, 60),
        club: clean(x?.club, 60),
      });
      const p1 = p(body.p1);
      const p2 = p(body.p2);
      if (p1.name.length < 3 || p2.name.length < 3) return fail('Escribe el nombre completo de ambos jugadores.');
      if (!/^[0-9+\s-]{10,20}$/.test(p1.phone)) return fail('Escribe un teléfono válido (10 dígitos) del jugador 1.');
      if (p1.email && !/^\S+@\S+\.\S+$/.test(p1.email)) return fail('El correo del jugador 1 no es válido.');
      if (!body.terms) return fail('Debes aceptar el reglamento.');
      const team = E.makeTeam(body.categoryId, p1, p2, { source: 'web', notes: clean(body.notes, 300) });
      await store().setJSON(`reg/${body.categoryId}/${team.id}`, team);
      const pendingCount = (await store().list({ prefix: `reg/${body.categoryId}/` })).blobs.length;
      const cat = state.categories.find((c) => c.id === body.categoryId);
      const waitlist = E.occupiedSpots(state, cat.id) + pendingCount > (cat.maxTeams || 999);
      return json({ ok: true, code: team.code, waitlist });
    }

    if (path === '/api/login' && method === 'POST') {
      const lockedMin = await checkLock(ip);
      if (lockedMin) return fail(`Demasiados intentos. Espera ${lockedMin} min.`, 429);
      const { password } = await readBody(req);
      let role = null;
      if (process.env.ADMIN_PASSWORD && safeEqual(password, process.env.ADMIN_PASSWORD)) role = 'admin';
      else if (process.env.SCORER_PASSWORD && safeEqual(password, process.env.SCORER_PASSWORD)) role = 'scorer';
      if (!process.env.ADMIN_PASSWORD) return fail('Falta configurar ADMIN_PASSWORD en Netlify.', 500);
      if (!role) {
        await registerFail(ip);
        return fail('Contraseña incorrecta.', 401);
      }
      await store().delete(`auth/${ip}`);
      return json({ ok: true, role }, 200, { 'set-cookie': cookieHeader(makeSession(role), SESSION_HOURS * 3600) });
    }

    if (path === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
    }

    if (path === '/api/me' && method === 'GET') {
      const s = getSession(req);
      return json({ role: s ? s.role : null });
    }

    // ---------- Protegido ----------
    if (path.startsWith('/api/admin/')) {
      const session = getSession(req);
      if (!session) return fail('Sesión expirada. Vuelve a iniciar sesión.', 401);
      const isAdmin = session.role === 'admin';
      const action = path.slice('/api/admin/'.length);
      const adminOnly = () => {
        if (!isAdmin) throw Object.assign(new Error('Solo la mesa de control (admin) puede hacer esto.'), { status: 403 });
      };

      if (action === 'state' && method === 'GET') {
        let state = await loadState();
        if (isAdmin) {
          const keys = await absorbRegistrations(state);
          if (keys) {
            state = await saveState(state, state.version);
            for (const k of keys) await store().delete(k);
          }
        }
        return json({ role: session.role, state: isAdmin ? state : stripPrivate(state) });
      }

      if (action === 'save' && method === 'POST') {
        adminOnly();
        const { state, baseVersion } = await readBody(req);
        if (!state || !Array.isArray(state.matches)) return fail('Estado inválido.');
        const current = await loadState();
        if (current.version !== baseVersion)
          return json({ error: 'Otra persona guardó cambios antes que tú. Se cargó la versión más reciente.', state: current }, 409);
        // Recalcular en servidor para garantizar consistencia
        E.propagate(state);
        state.categories.forEach((c) => E.refreshCategoryStatus(state, c.id));
        const saved = await saveState(state, current.version);
        return json({ ok: true, state: saved });
      }

      if (action === 'score' && method === 'POST') {
        const { matchId, payload, knownUpdatedAt } = await readBody(req);
        const state = await loadState();
        const m = state.matches.find((x) => x.id === matchId);
        if (!m) return fail('Partido no encontrado.', 404);
        const conflict = knownUpdatedAt !== undefined && (m.updatedAt || null) !== (knownUpdatedAt || null);
        if (!isAdmin) {
          // el capturista solo puede cambiar marcador y estado
          delete payload.court;
          delete payload.time;
        }
        E.applyScore(state, matchId, payload, isAdmin ? 'admin' : 'capturista');
        const saved = await saveState(state, state.version);
        return json({ ok: true, conflict, state: isAdmin ? saved : stripPrivate(saved) });
      }

      if (action === 'undo' && method === 'POST') {
        adminOnly();
        const { logId } = await readBody(req);
        const state = await loadState();
        E.undoLog(state, logId);
        return json({ ok: true, state: await saveState(state, state.version) });
      }

      if (action === 'history' && method === 'GET') {
        adminOnly();
        const { blobs } = await store().list({ prefix: 'history/' });
        const items = [];
        for (const b of blobs.map((x) => x.key).sort().reverse().slice(0, HISTORY_KEEP)) {
          const s = await store().get(b, { type: 'json' });
          if (s) items.push({ key: b, version: s.version, updatedAt: s.updatedAt, last: s.log?.[0]?.msg || '' });
        }
        return json({ items });
      }

      if (action === 'restore' && method === 'POST') {
        adminOnly();
        const { key } = await readBody(req);
        if (!/^history\/\d+$/.test(key || '')) return fail('Versión inválida.');
        const old = await store().get(key, { type: 'json' });
        if (!old) return fail('Esa versión ya no existe.', 404);
        const current = await loadState();
        E.addLog(old, 'admin', `Restaurada la versión ${old.version}`);
        return json({ ok: true, state: await saveState(old, current.version) });
      }

      if (action === 'demo' && method === 'POST') {
        adminOnly();
        const current = await loadState();
        return json({ ok: true, state: await saveState(E.demoTournament(), current.version) });
      }
    }

    return fail('Ruta no encontrada.', 404);
  } catch (err) {
    // Los errores de reglas del motor son `Error` simples (mensaje para el usuario); el resto es un fallo interno
    const status = err.status || (err.constructor === Error ? 400 : 500);
    if (status >= 500) console.error(err);
    return fail(err.message || 'Error interno', status);
  }
};

export const config = { path: '/api/*' };
