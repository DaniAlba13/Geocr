// Flota John Deere: sincroniza equipos (Equipment API) y telemetría ISO 15143-3 (AEMP) en D1.
//  · Tabla flota_maq: una fila por máquina con su última lectura.
//  · Tabla flota_dia: una fila por máquina y día (hora RD) con la primera y la última lectura del día
//    (horas acumuladas, ralentí acumulado, combustible acumulado) para calcular lo trabajado cada día.
// Rutas: GET /api/flota (tablero, con sesión) · POST /api/flota/sync (sincronizar ahora, con sesión)
//        GET /pbi/<tabla>.csv?k=PBI_KEY (Power BI, sin sesión, con la clave del secret PBI_KEY)
import { getJD } from './jd.js';

const EQ = 'https://equipmentapi.deere.com/isg/equipment';
const aemp = env => String(env.JD_AEMP || 'https://partneraemp.deere.com').replace(/\/+$/, '');
const hoyRD = (t = Date.now()) => new Date(t - 4 * 3600e3).toISOString().slice(0, 10);
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function tablas(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS flota_maq (id TEXT PRIMARY KEY, data TEXT NOT NULL, upd TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_dia (id TEXT NOT NULL, fecha TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, fecha))'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_meta (k TEXT PRIMARY KEY, v TEXT)'),
  ]);
}

// ---- XML ISO 15143-3 (sin DOMParser en Workers: lectura tolerante por etiquetas) ----
const tag = (x, n) => { const m = x && x.match(new RegExp(`<(?:\\w+:)?${n}\\b([^>]*)>([\\s\\S]*?)</(?:\\w+:)?${n}>`)); return m ? { a: m[1], v: m[2] } : null; };
const txt = (x, n) => { const t = tag(x, n); return t ? t.v.trim() : ''; };
const num = (x, n) => { const v = parseFloat(txt(x, n)); return isFinite(v) ? v : null; };
const fdt = t => (t && (t.a.match(/datetime="([^"]+)"/i) || [])[1]) || null;
export function isoEquipo(b) {
  const h = tag(b, 'EquipmentHeader'), H = h ? h.v : '';
  const loc = tag(b, 'Location'), oh = tag(b, 'CumulativeOperatingHours'), ih = tag(b, 'CumulativeIdleHours'), fu = tag(b, 'FuelUsed'),
    f24 = tag(b, 'FuelUsedLast24'), fr = tag(b, 'FuelRemaining'), dr = tag(b, 'DEFRemaining'), es = tag(b, 'EngineStatus'), di = tag(b, 'Distance');
  return {
    marca: txt(H, 'OEMName'), modelo: txt(H, 'Model'), equipo: txt(H, 'EquipmentID'), serie: txt(H, 'SerialNumber'), pin: txt(H, 'PIN'),
    lat: loc ? num(loc.v, 'Latitude') : null, lon: loc ? num(loc.v, 'Longitude') : null, f_pos: fdt(loc),
    horas: oh ? num(oh.v, 'Hour') : null, f_horas: fdt(oh), ralenti: ih ? num(ih.v, 'Hour') : null,
    comb: fu ? num(fu.v, 'FuelConsumed') : null, comb_u: fu ? txt(fu.v, 'FuelUnits') : '', f_comb: fdt(fu), comb24: f24 ? num(f24.v, 'FuelConsumed') : null,
    comb_pct: fr ? num(fr.v, 'Percent') : null, def_pct: dr ? num(dr.v, 'Percent') : null,
    motor: es ? /true|on/i.test(txt(es.v, 'Running') || es.v) : null, f_motor: fdt(es),
    odom: di ? num(di.v, 'Odometer') : null,
  };
}
async function flotaISO(env) {
  let url = aemp(env) + '/Fleet/1'; const out = []; let muestra = '';
  for (let i = 0; i < 40 && url; i++) {
    const r = await getJD(env, url, 'application/xml');
    if (r.status !== 200) throw new Error(`ISO 15143-3 respondió ${r.status}`);
    const x = r.txt, bl = x.match(/<(?:\w+:)?Equipment\b[\s\S]*?<\/(?:\w+:)?Equipment>/g) || [];
    if (!muestra && bl[0]) muestra = bl[0].slice(0, 4000);
    bl.forEach(b => out.push(isoEquipo(b)));
    const nx = [...x.matchAll(/<Links>([\s\S]*?)<\/Links>/g)].map(m => m[1]).find(l => /<rel>\s*next\s*<\/rel>/i.test(l));
    url = nx ? txt(nx, 'href') : null;
  }
  return { out, muestra };
}
async function equipos(env, org) {
  let url = `${EQ}?organizationIds=${encodeURIComponent(org)}&itemLimit=100`; const out = [];
  for (let i = 0; i < 40 && url; i++) {
    const r = await getJD(env, url, 'application/json');
    if (r.status !== 200) throw new Error(`Equipment API respondió ${r.status}`);
    (r.json && r.json.values || []).forEach(v => out.push(v));
    const nx = ((r.json && r.json.links) || []).find(l => l.rel === 'nextPage'); url = nx ? nx.uri : null;
  }
  return out;
}
const nom = o => (o && (o.name || o.displayName || o.value)) || (typeof o === 'string' ? o : '');
const clave = s => String(s || '').toUpperCase().replace(/\s+/g, '');

export async function syncFlota(env) {
  const db = env.DB; await tablas(db);
  const t0 = new Date().toISOString();
  try {
    const o = await getJD(env, '/organizations');
    const org = ((o.json && o.json.values) || []).find(g => !((g.links || []).some(l => l.rel === 'connections')));
    if (!org) throw new Error('No hay organización aprobada para AgroAP-CR.');
    const [eq, iso] = await Promise.all([equipos(env, org.id).catch(e => ({ error: e.message })), flotaISO(env)]);
    const E = Array.isArray(eq) ? eq.filter(v => !v['@type'] || /machine/i.test(v['@type'])) : [];
    const porPin = new Map(); E.forEach(v => { [v.vin, v.serialNumber, v.identificationNumber, v.pin, v.productIdentificationNumber].filter(Boolean).forEach(k => porPin.set(clave(k), v)); });
    const fecha = hoyRD(), st = [], vistos = new Set();
    const prev = new Map(((await db.prepare('SELECT id,data FROM flota_dia WHERE fecha=?1').bind(fecha).all()).results || []).map(r => [r.id, JSON.parse(r.data)]));
    for (const m of iso.out) {
      const id = clave(m.pin || m.serie || m.equipo); if (!id || vistos.has(id)) continue; vistos.add(id);
      const e = porPin.get(clave(m.pin)) || porPin.get(clave(m.serie)) || null;
      const d = { id, ...m, nombre: (e && e.name) || m.equipo || m.modelo || id, tipo: e ? nom(e.equipmentType || e.type) : '', modelo: (e && nom(e.equipmentModel)) || m.modelo,
        marca: (e && nom(e.equipmentMake)) || m.marca, anio: e && (e.modelYear || e.year) || null, eq_id: e && e.id || null, upd: t0 };
      st.push(db.prepare('INSERT INTO flota_maq (id,data,upd) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data, upd=excluded.upd').bind(id, JSON.stringify(d), t0));
      if (m.horas != null || m.comb != null) {
        const p = prev.get(id) || { h_ini: m.horas, r_ini: m.ralenti, c_ini: m.comb, n: 0 };
        const r = { ...p, h_fin: m.horas, r_fin: m.ralenti, c_fin: m.comb, c24: m.comb24, lat: m.lat, lon: m.lon, n: (p.n || 0) + 1, upd: t0 };
        if (r.h_ini == null) r.h_ini = m.horas; if (r.r_ini == null) r.r_ini = m.ralenti; if (r.c_ini == null) r.c_ini = m.comb;
        st.push(db.prepare('INSERT INTO flota_dia (id,fecha,data) VALUES (?1,?2,?3) ON CONFLICT(id,fecha) DO UPDATE SET data=excluded.data').bind(id, fecha, JSON.stringify(r)));
      }
    }
    // equipos sin telemetría ISO (se listan igual en el tablero)
    for (const v of E) {
      const id = clave(v.vin || v.serialNumber || v.identificationNumber || v.id); if (!id || vistos.has(id)) continue; vistos.add(id);
      st.push(db.prepare('INSERT INTO flota_maq (id,data,upd) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data, upd=excluded.upd')
        .bind(id, JSON.stringify({ id, nombre: v.name || id, tipo: nom(v.equipmentType || v.type), modelo: nom(v.equipmentModel), marca: nom(v.equipmentMake), anio: v.modelYear || null, eq_id: v.id, sin_iso: true, upd: t0 }), t0));
    }
    const meta = { upd: t0, org: org.name, n_iso: iso.out.length, n_eq: E.length, error_eq: Array.isArray(eq) ? '' : eq.error, ok: true };
    st.push(db.prepare("INSERT INTO flota_meta (k,v) VALUES ('estado',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(meta)));
    st.push(db.prepare("INSERT INTO flota_meta (k,v) VALUES ('muestra',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify({ iso: iso.muestra, eq: E[0] || null })));
    for (let i = 0; i < st.length; i += 80) await db.batch(st.slice(i, i + 80));
    return meta;
  } catch (e) {
    const meta = { upd: t0, ok: false, error: String(e && e.message || e) };
    await db.prepare("INSERT INTO flota_meta (k,v) VALUES ('estado',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(meta)).run();
    return meta;
  }
}

async function datos(env, dias) {
  const db = env.DB; await tablas(db);
  const desde = hoyRD(Date.now() - dias * 864e5);
  const [m, d, s] = await Promise.all([db.prepare('SELECT data FROM flota_maq').all(), db.prepare('SELECT id,fecha,data FROM flota_dia WHERE fecha>=?1 ORDER BY fecha').bind(desde).all(),
    db.prepare("SELECT v FROM flota_meta WHERE k='estado'").first()]);
  return { maq: (m.results || []).map(r => JSON.parse(r.data)), dia: (d.results || []).map(r => ({ id: r.id, fecha: r.fecha, ...JSON.parse(r.data) })), estado: s ? JSON.parse(s.v) : null };
}
// lo trabajado cada día = diferencia de los acumulados contra la última lectura del día anterior (o la primera del mismo día)
function porDia(D) {
  const g = new Map(); D.forEach(r => { if (!g.has(r.id)) g.set(r.id, []); g.get(r.id).push(r); });
  const out = []; const dif = (a, b) => (a != null && b != null && a >= b) ? a - b : null;
  g.forEach(L => { L.sort((a, b) => a.fecha < b.fecha ? -1 : 1); L.forEach((r, i) => { const p = i ? L[i - 1] : null;
    out.push({ id: r.id, fecha: r.fecha, horas: dif(r.h_fin, p ? p.h_fin : r.h_ini), ralenti: dif(r.r_fin, p ? p.r_fin : r.r_ini), comb: dif(r.c_fin, p ? p.c_fin : r.c_ini), comb24: r.c24 ?? null,
      horas_acum: r.h_fin, lat: r.lat, lon: r.lon }); }); });
  return out;
}
export async function rutaFlota(request, env, path) {
  if (path[1] === 'sync' && request.method === 'POST') return J(await syncFlota(env));
  if (path[1] === 'muestra') { await tablas(env.DB); const r = await env.DB.prepare("SELECT v FROM flota_meta WHERE k='muestra'").first(); return J(r ? JSON.parse(r.v) : {}); }
  const u = new URL(request.url), dias = Math.min(Math.max(parseInt(u.searchParams.get('dias') || '45', 10) || 45, 1), 400);
  const x = await datos(env, dias); return J({ estado: x.estado, maq: x.maq, dia: porDia(x.dia) });
}
// ---- Power BI: CSV sin sesión, con la clave PBI_KEY ----
const csv = (rows, cols) => '﻿' + cols.join(',') + '\n' + rows.map(r => cols.map(c => { const v = r[c]; if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
export async function rutaPBI(request, env, url) {
  const k = url.searchParams.get('k') || '', K = String(env.PBI_KEY || '');
  if (!K || k.length !== K.length || [...k].reduce((a, c, i) => a | (c.charCodeAt(0) ^ K.charCodeAt(i)), 0)) return new Response('Clave inválida o no configurada (secret PBI_KEY).', { status: 401 });
  const t = url.pathname.split('/').pop().replace(/\.csv$/, ''), dias = Math.min(parseInt(url.searchParams.get('dias') || '400', 10) || 400, 1000);
  const x = await datos(env, dias), h = { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' };
  if (t === 'maquinas') return new Response(csv(x.maq, ['id', 'nombre', 'tipo', 'marca', 'modelo', 'anio', 'serie', 'pin', 'horas', 'ralenti', 'comb', 'comb_u', 'comb_pct', 'def_pct', 'motor', 'lat', 'lon', 'f_pos', 'f_horas', 'upd']), { headers: h });
  if (t === 'diario') return new Response(csv(porDia(x.dia), ['id', 'fecha', 'horas', 'ralenti', 'comb', 'comb24', 'horas_acum', 'lat', 'lon']), { headers: h });
  return new Response('Tablas: /pbi/maquinas.csv y /pbi/diario.csv', { status: 404 });
}
