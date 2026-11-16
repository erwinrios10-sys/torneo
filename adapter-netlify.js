// Adaptador de la mesa de control para el sitio en Netlify (API + sesión por cookie)
import { startAdmin } from './admin.js';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error || `Error ${res.status}`);
    err.status = res.status;
    if (j.state) err.state = j.state;
    throw err;
  }
  return j;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

let version = null;
const keep = (s) => { version = s.version; return s; };

const adapter = {
  label: '',
  publicUrl: '/',
  canLogout: true,
  async init() {
    const me = await api('/api/me');
    if (!me.role) return { needLogin: true };
    const r = await api('/api/admin/state');
    return { role: r.role, state: keep(r.state) };
  },
  async login(password) {
    await post('/api/login', { password });
    const r = await api('/api/admin/state');
    return { role: r.role, state: keep(r.state) };
  },
  logout: () => post('/api/logout'),
  async save(state, baseVersion) {
    try {
      return keep((await post('/api/admin/save', { state, baseVersion })).state);
    } catch (e) {
      if (e.state) keep(e.state);
      throw e;
    }
  },
  async score(matchId, payload, knownUpdatedAt) {
    const r = await post('/api/admin/score', { matchId, payload, knownUpdatedAt });
    return { state: keep(r.state), conflict: r.conflict };
  },
  async undo(logId) { return keep((await post('/api/admin/undo', { logId })).state); },
  async demo() { return keep((await post('/api/admin/demo')).state); },
  async history() { return (await api('/api/admin/history')).items; },
  async restore(key) { return keep((await post('/api/admin/restore', { key })).state); },
  // Revisa cada 10 s si alguien (otro admin o un capturista) guardó cambios
  watch(cb) {
    setInterval(async () => {
      if (document.visibilityState !== 'visible' || version == null) return;
      try {
        const p = await api(`/api/public?v=${version}`);
        if (p.changed) {
          const r = await api('/api/admin/state');
          cb(keep(r.state));
        }
      } catch { /* sin conexión: se reintenta */ }
    }, 10000);
  },
};

startAdmin(adapter, document.getElementById('admin'));
