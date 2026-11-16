// Pruebas del motor: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine as E } from '../public/js/engine.js';

const fmt = E.defaultFormat();

test('validación de sets', () => {
  assert.equal(E.setWinner(6, 4, fmt, false), 'A');
  assert.equal(E.setWinner(5, 7, fmt, false), 'B');
  assert.equal(E.setWinner(7, 6, fmt, false), 'A');
  assert.throws(() => E.setWinner(6, 5, fmt, false));
  assert.throws(() => E.setWinner(8, 6, fmt, false));
  assert.throws(() => E.setWinner(5, 3, fmt, false));
  assert.equal(E.setWinner(10, 8, fmt, true), 'A');
  assert.equal(E.setWinner(12, 14, fmt, true), 'B');
  assert.throws(() => E.setWinner(10, 9, fmt, true));
  assert.throws(() => E.setWinner(9, 7, fmt, true));
  const noTB = { ...fmt, tiebreak: false };
  assert.equal(E.setWinner(8, 6, noTB, false), 'A');
  assert.throws(() => E.setWinner(7, 6, noTB, false));
  const pro = { type: 'oneSet', setGames: 9, tiebreak: true };
  assert.equal(E.validateScore([[9, 8]], pro).winner, 'A');
  assert.throws(() => E.validateScore([[6, 4]], pro));
});

test('partido completo mejor de 3', () => {
  assert.equal(E.validateScore([[6, 4], [6, 3]], fmt).winner, 'A');
  assert.equal(E.validateScore([[6, 4], [3, 6], [8, 10]], fmt).winner, 'B');
  assert.throws(() => E.validateScore([[6, 4]], fmt));
  assert.throws(() => E.validateScore([[6, 4], [6, 3], [6, 1]], fmt));
  assert.throws(() => E.validateScore([[6, 4], [3, 6], [6, 4]], fmt)); // 3er set debe ser súper TB
});

test('round robin: todos contra todos sin repetir', () => {
  for (const n of [3, 4, 5, 6]) {
    const ids = Array.from({ length: n }, (_, i) => 't' + i);
    const pairs = E.roundRobin(ids).flat();
    assert.equal(pairs.length, (n * (n - 1)) / 2);
    const keys = new Set(pairs.map((p) => p.slice().sort().join('-')));
    assert.equal(keys.size, pairs.length);
  }
});

function setupCat(n, mutate) {
  const s = E.newTournament();
  const c = E.addCategory(s, 'Test');
  if (mutate) mutate(c);
  for (let i = 0; i < n; i++) {
    s.teams.push(E.makeTeam(c.id, { name: 'A' + i, club: i % 2 ? 'X' : 'Y' }, { name: 'B' + i }, { status: 'confirmed', seed: i < 4 ? i + 1 : null }));
  }
  return { s, c };
}

test('grupos por siembra en serpentina', () => {
  const { s, c } = setupCat(16, (c) => { c.config.groups.avoidSameClub = false; });
  const g = E.proposeGroups(s, c.id);
  assert.equal(g.length, 4);
  g.forEach((x) => assert.equal(x.teamIds.length, 4));
  const seedOf = (id) => s.teams.find((t) => t.id === id).seed;
  // Cada cabeza de serie en un grupo distinto
  assert.deepEqual(g.map((x) => seedOf(x.teamIds[0])), [1, 2, 3, 4]);
  E.applyGroups(s, c.id, g);
  assert.equal(s.matches.length, 4 * 6);
});

test('grupos desiguales (10 parejas en grupos de 3)', () => {
  const { s, c } = setupCat(10, (c) => { c.config.groups.size = 3; });
  const g = E.proposeGroups(s, c.id);
  assert.equal(g.reduce((a, x) => a + x.teamIds.length, 0), 10);
  assert.ok(g.every((x) => x.teamIds.length >= 3 && x.teamIds.length <= 4));
});

test('tabla, desempate por enfrentamiento directo y W.O.', () => {
  const { s, c } = setupCat(3, (c) => { c.config.groups.size = 3; });
  E.applyGroups(s, c.id, E.proposeGroups(s, c.id));
  const [g] = s.groups;
  const [t1, t2, t3] = g.teamIds;
  const find = (a, b) => s.matches.find((m) => (m.teamA === a && m.teamB === b) || (m.teamA === b && m.teamB === a));
  const win = (a, b, sets) => {
    const m = find(a, b);
    const flip = m.teamA !== a;
    E.applyScore(s, m.id, { status: 'finished', sets: flip ? sets.map(([x, y]) => [y, x]) : sets });
  };
  win(t1, t2, [[6, 0], [6, 0]]);
  win(t2, t3, [[6, 0], [6, 0]]);
  // t3 gana a t1 por W.O.
  const m = find(t3, t1);
  E.applyScore(s, m.id, { status: 'walkover', winner: m.teamA === t3 ? 'A' : 'B' });
  const st = E.standings(s, g.id);
  assert.equal(st.length, 3);
  // todos 1-1; t1 perdió por W.O. => 0 pts por esa derrota
  const pts = Object.fromEntries(st.map((r) => [r.teamId, r.points]));
  assert.equal(pts[t1], 2);
  assert.equal(pts[t2], 3);
  assert.equal(pts[t3], 3);
  assert.equal(st[2].teamId, t1);
  // t2 vs t3 empatados en puntos: h2h -> t2 ganó a t3
  assert.equal(st[0].teamId, t2);
  assert.ok(E.groupsComplete(s, c.id));
});

test('llave con BYEs, avance y 3er lugar', () => {
  const { s, c } = setupCat(9, (c) => { c.config.groups.size = 3; c.config.ko.thirdPlace = true; });
  E.applyGroups(s, c.id, E.proposeGroups(s, c.id));
  s.matches.filter((m) => m.stage === 'group').forEach((m) => E.applyScore(s, m.id, { status: 'finished', sets: [[6, 2], [6, 3]] }));
  E.generateKnockout(s, c.id);
  const ko = s.matches.filter((m) => m.stage === 'ko');
  assert.equal(ko.filter((m) => m.round === 1).length, 4); // 6 clasificados -> llave de 8
  const byes = ko.filter((m) => m.status === 'bye');
  assert.equal(byes.length, 2);
  // Los BYE avanzan a los primeros sembrados
  const r2 = ko.filter((m) => m.round === 2);
  assert.ok(r2.some((m) => m.teamA || m.teamB));
  // jugar todo
  for (let r = 1; r <= 3; r++) {
    s.matches.filter((m) => m.stage === 'ko' && m.round === r && m.status === 'scheduled').forEach((m) => {
      E.applyScore(s, m.id, { status: 'finished', sets: [[6, 1], [6, 1]] });
    });
  }
  const third = s.matches.find((m) => m.stage === 'third');
  assert.ok(third.teamA && third.teamB);
  E.applyScore(s, third.id, { status: 'finished', sets: [[6, 1], [6, 1]] });
  const champ = E.champions(s, c.id);
  assert.ok(champ.first && champ.second && champ.third);
  assert.equal(c.status, 'finished');
});

test('cruce 1A vs 2B y sin revancha', () => {
  const { s, c } = setupCat(16, (c) => { c.config.groups.avoidSameClub = false; });
  E.applyGroups(s, c.id, E.proposeGroups(s, c.id));
  s.matches.forEach((m) => E.applyScore(s, m.id, { status: 'finished', sets: [[6, 2], [6, 2]] }));
  E.generateKnockout(s, c.id);
  const gOf = (id) => s.groups.find((g) => g.teamIds.includes(id)).id;
  const r1 = s.matches.filter((m) => m.stage === 'ko' && m.round === 1);
  assert.equal(r1.length, 4);
  r1.forEach((m) => assert.notEqual(gOf(m.teamA), gOf(m.teamB)));
});

test('cambiar un resultado limpia la ronda siguiente y deshacer funciona', () => {
  const { s, c } = setupCat(4);
  E.generateKnockout(s, c.id); // llave directa sin grupos
  const r1 = s.matches.filter((m) => m.stage === 'ko' && m.round === 1);
  r1.forEach((m) => E.applyScore(s, m.id, { status: 'finished', sets: [[6, 1], [6, 1]] }));
  const final = s.matches.find((m) => m.stage === 'ko' && m.round === 2);
  assert.ok(final.teamA && final.teamB);
  E.applyScore(s, final.id, { status: 'finished', sets: [[6, 1], [6, 1]] });
  assert.equal(c.status, 'finished');
  // corregir semifinal: ahora gana B
  E.applyScore(s, r1[0].id, { status: 'finished', sets: [[1, 6], [1, 6]] });
  assert.equal(final.status, 'scheduled');
  assert.equal(final.teamA, r1[0].teamB);
  assert.equal(c.status, 'knockout');
  // deshacer
  const entry = s.log.find((l) => l.matchId === r1[0].id);
  E.undoLog(s, entry.id);
  const r1b = s.matches.find((m) => m.id === r1[0].id);
  assert.equal(r1b.winner, 'A');
});

test('calendario automático sin choques', () => {
  const { s, c } = setupCat(12, (c) => { c.config.groups.size = 4; });
  E.applyGroups(s, c.id, E.proposeGroups(s, c.id));
  s.schedule.days = [{ date: '2026-12-05', start: '08:00', end: '22:00' }];
  s.schedule.slotMinutes = 60;
  s.schedule.restMinutes = 60;
  const r = E.autoSchedule(s);
  assert.equal(r.unplaced, 0);
  const seen = new Set();
  for (const m of s.matches) {
    const k = m.time + m.court;
    assert.ok(!seen.has(k), 'dos partidos en la misma pista y hora');
    seen.add(k);
  }
  // Cada pareja descansa al menos 1 slot entre partidos
  for (const t of s.teams) {
    const times = s.matches.filter((m) => m.teamA === t.id || m.teamB === t.id).map((m) => Date.parse(m.time + ':00Z')).sort();
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 120 * 60000);
  }
});

test('vista pública no expone datos privados', () => {
  const s = E.demoTournament();
  const pub = JSON.stringify(E.publicView(s));
  assert.ok(!pub.includes('@ejemplo.com'));
  assert.ok(!pub.includes('"phone"'));
  assert.ok(!pub.includes('"paid"'));
});

test('demo completa se genera sin errores', () => {
  const s = E.demoTournament();
  assert.ok(s.matches.length > 30);
  assert.ok(s.matches.some((m) => m.stage === 'ko'));
});
