// Flota John Deere: sincroniza equipos (Equipment API) y telemetría ISO 15143-3 (AEMP) en D1.
//  · Tabla flota_maq: una fila por máquina con su última lectura.
//  · Tabla flota_dia: una fila por máquina y día (hora RD) con la primera y la última lectura del día
//    (horas acumuladas, ralentí acumulado, combustible acumulado) para calcular lo trabajado cada día.
// Rutas: GET /api/flota (tablero, con sesión) · POST /api/flota/sync (sincronizar ahora, con sesión)
//        GET /pbi/<tabla>.csv?k=PBI_KEY (Power BI, sin sesión, con la clave del secret PBI_KEY)
import { getJD } from './jd.js';
import { horasHist, alertasJD, muestraHist } from './historia.js';

const EQ = 'https://equipmentapi.deere.com/isg/equipment';
const aemp = env => String(env.JD_AEMP || 'https://partneraemp.deere.com').replace(/\/+$/, '');
const hoyRD = (t = Date.now()) => new Date(t - 4 * 3600e3).toISOString().slice(0, 10);
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function tablas(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS flota_maq (id TEXT PRIMARY KEY, data TEXT NOT NULL, upd TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_dia (id TEXT NOT NULL, fecha TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, fecha))'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_meta (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_pos (id TEXT NOT NULL, ts TEXT NOT NULL, lat REAL, lon REAL, horas REAL, PRIMARY KEY (id, ts))'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_tq (id TEXT NOT NULL, ts TEXT NOT NULL, pct REAL, PRIMARY KEY (id, ts))'),
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
    comb_pct: fr ? num(fr.v, 'Percent') : null, f_tq: fdt(fr), def_pct: dr ? num(dr.v, 'Percent') : null,
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
      // posición de cada lectura (para el avance de cosecha: qué piezas tienen cosechadora trabajando)
      if (m.lat != null && m.lon != null) st.push(db.prepare('INSERT OR IGNORE INTO flota_pos (id,ts,lat,lon,horas) VALUES (?1,?2,?3,?4,?5)').bind(id, m.f_pos || t0, m.lat, m.lon, m.horas));
      if (m.comb_pct != null) st.push(db.prepare('INSERT OR IGNORE INTO flota_tq (id,ts,pct) VALUES (?1,?2,?3)').bind(id, m.f_tq || t0, m.comb_pct));
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
    st.push(db.prepare('DELETE FROM flota_pos WHERE ts < ?1').bind(new Date(Date.now() - 200 * 864e5).toISOString()));
    st.push(db.prepare('DELETE FROM flota_tq WHERE ts < ?1').bind(new Date(Date.now() - 200 * 864e5).toISOString()));
    for (let i = 0; i < st.length; i += 80) await db.batch(st.slice(i, i + 80));
    return meta;
  } catch (e) {
    const meta = { upd: t0, ok: false, error: String(e && e.message || e) };
    await db.prepare("INSERT INTO flota_meta (k,v) VALUES ('estado',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(meta)).run();
    return meta;
  }
}

async function datos(env, dias, X) {
  const db = env.DB; await tablas(db);
  const desde = hoyRD(Date.now() - dias * 864e5);
  const [m, d, s, q] = await Promise.all([db.prepare('SELECT data FROM flota_maq').all(), db.prepare('SELECT id,fecha,data FROM flota_dia WHERE fecha>=?1 ORDER BY fecha').bind(desde).all(),
    db.prepare("SELECT v FROM flota_meta WHERE k='estado'").first(), db.prepare('SELECT id,ts,pct FROM flota_tq WHERE ts>=?1 ORDER BY id,ts').bind(new Date(Date.now() - (dias + 1) * 864e5).toISOString()).all()]);
  const maq = (m.results || []).map(r => JSON.parse(r.data)); maq.forEach(x => { const e = especMaq(x, X); if (e) x.espec = e; });
  return { maq, dia: (d.results || []).map(r => ({ id: r.id, fecha: r.fecha, ...JSON.parse(r.data) })), tq: q.results || [], estado: s ? JSON.parse(s.v) : null };
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
  if (path[1] === 'pos') {   // posiciones de los últimos días (avance de cosecha)
    await tablas(env.DB); const u = new URL(request.url), d = Math.min(Math.max(parseInt(u.searchParams.get('dias') || '3', 10) || 3, 1), 200);
    const r = await env.DB.prepare('SELECT id,ts,lat,lon,horas FROM flota_pos WHERE ts >= ?1 ORDER BY id, ts').bind(new Date(Date.now() - d * 864e5).toISOString()).all();
    return J(r.results || []);
  }
  if (path[1] === 'combustible') return diagComb(env);
  if (path[1] === 'historia') return probarHistoria(env);
  if (path[1] === 'historia2') return probarMaquinas(env);   // prueba: ¿John Deere entrega histórico (series de tiempo)?   // diagnóstico: qué dice John Deere del combustible de cada máquina
  if (path[1] === 'historial') return muestraHist(env);   // avance y muestra de la carga del historial
  if (path[1] === 'alertas') {   // alertas de diagnóstico John Deere agrupadas (para informes)
    const u = new URL(request.url), d = u.searchParams.get('desde') || hoyRD(Date.now() - 7 * 864e5), h = u.searchParams.get('hasta') || hoyRD();
    return J(await alertasJD(env, d + 'T04:00:00Z', new Date(Date.parse(h + 'T04:00:00Z') + 864e5).toISOString(), u.searchParams.get('id') || null));
  }
  if (path[1] === 'muestra') { await tablas(env.DB); const r = await env.DB.prepare("SELECT v FROM flota_meta WHERE k='muestra'").first(); return J(r ? JSON.parse(r.v) : {}); }
  const u = new URL(request.url), dias = Math.min(Math.max(parseInt(u.searchParams.get('dias') || '45', 10) || 45, 1), 400);
  const X = Math.min(Math.max(parseFloat(u.searchParams.get('carga')) || X_TRAC, 0.15), 0.9);
  const x = await datos(env, dias, X), D = porDia(x.dia), ya = new Set(D.map(r => r.id + '|' + r.fecha));
  // días anteriores a la telemetría propia: horas encendida del historial de John Deere (sin separar el ralentí)
  (await horasHist(env, hoyRD(Date.now() - dias * 864e5)).catch(() => [])).forEach(h => { if (!ya.has(h.id + '|' + h.fecha) && h.horas > 0) D.push({ id: h.id, fecha: h.fecha, horas: h.horas, hist: 1 }); });
  const al = await alertasJD(env, hoyRD(Date.now() - dias * 864e5) + 'T04:00:00Z', new Date(Date.now() + 864e5).toISOString()).catch(() => []);
  return J({ estado: x.estado, maq: x.maq, dia: estimaComb(D, x.maq, x.tq), alj: al });
}
// ---- Power BI: CSV sin sesión, con la clave PBI_KEY ----
const csv = (rows, cols) => '﻿' + cols.join(',') + '\n' + rows.map(r => cols.map(c => { const v = r[c]; if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
export async function rutaPBI(request, env, url) {
  const k = url.searchParams.get('k') || '', K = String(env.PBI_KEY || '');
  if (!K || k.length !== K.length || [...k].reduce((a, c, i) => a | (c.charCodeAt(0) ^ K.charCodeAt(i)), 0)) return new Response('Clave inválida o no configurada (secret PBI_KEY).', { status: 401 });
  const t = url.pathname.split('/').pop().replace(/\.csv$/, ''), dias = Math.min(parseInt(url.searchParams.get('dias') || '400', 10) || 400, 1000);
  const x = await datos(env, dias), h = { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' };
  if (t === 'maquinas') return new Response(csv(x.maq, ['id', 'nombre', 'tipo', 'marca', 'modelo', 'anio', 'serie', 'pin', 'horas', 'ralenti', 'comb', 'comb_u', 'comb_pct', 'def_pct', 'motor', 'lat', 'lon', 'f_pos', 'f_horas', 'upd']), { headers: h });
  if (t === 'diario') return new Response(csv(estimaComb(porDia(x.dia), x.maq, x.tq), ['id', 'fecha', 'horas', 'ralenti', 'comb', 'comb24', 'comb_est', 'comb_met', 'horas_acum', 'lat', 'lon']), { headers: h });
  return new Response('Tablas: /pbi/maquinas.csv y /pbi/diario.csv', { status: 404 });
}

// ---- diagnóstico del combustible: lectura en vivo de John Deere + lo guardado por día ----
async function diagComb(env) {
  const e = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let url = aemp(env) + '/Fleet/1'; const filas = [], tags = new Map(); let err = '';
  try {
    for (let i = 0; i < 40 && url; i++) {
      const r = await getJD(env, url, 'application/xml'); if (r.status !== 200) throw new Error('John Deere respondió ' + r.status);
      const x = r.txt;
      (x.match(/<(?:\w+:)?Equipment\b[\s\S]*?<\/(?:\w+:)?Equipment>/g) || []).forEach(b => {
        [...b.matchAll(/<(?:\w+:)?(\w*Fuel\w*)\b/gi)].forEach(m => tags.set(m[1], (tags.get(m[1]) || 0) + 1));
        const m = isoEquipo(b), fu = tag(b, 'FuelUsed'), f24 = tag(b, 'FuelUsedLast24');
        filas.push({ id: clave(m.pin || m.serie || m.equipo), eq: m.equipo || m.modelo, modelo: m.modelo, horas: m.horas, f_horas: m.f_horas, comb: m.comb, u: m.comb_u, f_comb: m.f_comb,
          c24: m.comb24, f24: fdt(f24), pct: m.comb_pct, es: especMaq(m), crudo: ((fu ? fu.v : '') + (f24 ? ' | 24h: ' + f24.v : '')).replace(/\s+/g, ' ').slice(0, 300) });
      });
      const nx = [...x.matchAll(/<Links>([\s\S]*?)<\/Links>/g)].map(m => m[1]).find(l => /<rel>\s*next\s*<\/rel>/i.test(l)); url = nx ? txt(nx, 'href') : null;
    }
  } catch (x) { err = String(x.message || x); }
  await tablas(env.DB);
  const d = await env.DB.prepare('SELECT id,fecha,data FROM flota_dia WHERE fecha >= ?1 ORDER BY fecha').bind(new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10)).all();
  const g = new Map(); (d.results || []).forEach(r => { const o = JSON.parse(r.data); if (!g.has(r.id)) g.set(r.id, []); g.get(r.id).push(`${r.fecha.slice(8, 10)}/${r.fecha.slice(5, 7)}: ${o.c_ini ?? '–'} → ${o.c_fin ?? '–'}${o.c24 != null ? ' (24h ' + o.c24 + ')' : ''} · ${o.n || 0} lect.`); });
  const n = filas.length, nA = filas.filter(f => f.comb != null).length, n24 = filas.filter(f => f.c24 != null).length, nT = filas.filter(f => f.pct != null).length;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagnóstico combustible · AgroAP-CR</title>
<style>body{font:13px/1.45 Inter,Arial,sans-serif;margin:16px;color:#0E2A47}h1{font-size:18px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #E1E8F0;padding:5px 6px;text-align:left;vertical-align:top}th{background:#F4F7FA}.k{display:inline-block;margin:0 8px 8px 0;padding:8px 12px;border-radius:8px;background:#EEF4FB}.k b{font-size:18px;display:block}code{font-size:11px;color:#555;word-break:break-all}.w{overflow-x:auto}</style>
<h1>Diagnóstico de combustible (lectura en vivo de John Deere)</h1>${err ? `<p style="color:#C62828">Error: ${e(err)}</p>` : ''}
<div><span class="k"><b>${n}</b>máquinas con telemetría</span><span class="k"><b>${nA}</b>envían combustible acumulado</span><span class="k"><b>${n24}</b>envían combustible últimas 24 h</span><span class="k"><b>${nT}</b>envían % de tanque</span></div>
<p><b>Etiquetas de combustible encontradas en el XML:</b> ${[...tags].map(([k, v]) => e(k) + ' (' + v + ')').join(', ') || 'ninguna'}</p>
<div class="w"><table><tr><th>Máquina</th><th>Horas</th><th>Comb. acumulado</th><th>Últimas 24 h</th><th>Tanque</th><th>Ficha usada para estimar</th><th>Guardado por día (inicio → fin)</th><th>XML</th></tr>
${filas.map(f => `<tr><td><b>${e(f.eq)}</b><br>${e(f.modelo)}</td><td>${e(f.horas)}<br><small>${e(f.f_horas)}</small></td><td>${f.comb == null ? '–' : e(f.comb) + ' ' + e(f.u)}<br><small>${e(f.f_comb)}</small></td><td>${f.c24 == null ? '–' : e(f.c24)}<br><small>${e(f.f24)}</small></td><td>${f.pct == null ? '–' : e(f.pct) + ' %'}</td><td>${f.es ? (f.es.fuente === 'ficha' ? e(f.es.mod) : 'sin ficha') + ' · ' + f.es.hp + ' hp · tanque ' + (f.es.tanque ? f.es.tanque + ' L' : '?') + ' · ' + f.es.lh + ' L/h' : 'sin ficha'}</td><td>${(g.get(f.id) || []).map(e).join('<br>') || '–'}</td><td><code>${e(f.crudo) || '–'}</code></td></tr>`).join('')}</table></div>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// ---- consumo de combustible estimado ----
// John Deere (feed ISO 15143-3) no envía el combustible usado de esta flota, solo el % de tanque.
// Por eso el consumo diario se estima, en este orden:
//  1) "tanque": bajada del nivel de tanque (%) × capacidad del tanque del modelo; las subidas de más de 5 puntos son llenados y no cuentan.
//  2) "horas": horas trabajando × consumo de la ecuación ASABE D497 (Grisso et al., Virginia Tech BSE-328) a la carga media X
//     Q (gal/h) = (0.0434·X + 0.019) · P_TDF(hp), a plena aceleración; + horas en ralentí × consumo de ralentí del motor.
// Fichas técnicas John Deere (potencia hp, tanque L). Modelos sin ficha: potencia según la clase de hp que da John Deere.
const ESPEC = [
  [/CH ?670/i, 'CH670', 405, 605, 'cos'], [/CH ?570/i, 'CH570', 375, 605, 'cos'], [/CH ?9[56]0/i, 'CH950/960', 460, 750, 'cos'], [/3520/, '3520', 337, 600, 'cos'],
  [/6100J/i, '6100J', 100, 185], [/6105J/i, '6105J', 105, 185], [/6110J/i, '6110J', 110, 152], [/6115J/i, '6115J', 113, 240], [/6125J/i, '6125J', 125, 240], [/6130J/i, '6130J', 130, 240],
  [/6135J/i, '6135J', 133, 300], [/6140J/i, '6140J', 139, 300], [/6145J/i, '6145J', 145, 300], [/6150J/i, '6150J', 148, 300], [/6155J/i, '6155J', 155, 300], [/6165J/i, '6165J', 165, 300],
  [/6170J/i, '6170J', 168, 300], [/6180J/i, '6180J', 180, 300], [/6190J/i, '6190J', 187, 372], [/6205J/i, '6205J', 205, 372], [/6210J/i, '6210J', 207, 372],
  [/6190M/i, '6190M', 187, 372], [/6155M/i, '6155M', 155, 270], [/61[0-4]\dM/i, '6M', 125, 220],
  [/7185J/i, '7185J', 185, 392], [/7200J/i, '7200J', 200, 392], [/7205J/i, '7205J', 205, 392], [/7215J/i, '7215J', 215, 392], [/7225J/i, '7225J', 225, 392], [/7230J/i, '7230J', 230, 392],
  [/7230R/i, '7230R', 230, 500], [/5075E/i, '5075E', 75, 68], [/5076E/i, '5076E', 77, 95], [/5078E/i, '5078E', 78, 95], [/5082E/i, '5082E', 82, 95], [/5090E/i, '5090E', 90, 110],
];
const X_TRAC = 0.4, X_COS = 0.55, TDF = 0.85, RAL_KW = 0.018, GAL = 3.785;   // carga media (fracción de la potencia), potencia a la TDF / motor, ralentí (L/h por kW de motor)
const asabe = (X, hp) => (0.0434 * X + 0.019) * hp * GAL;   // L/h
function especMaq(m, X) {
  const t = [m.modelo, m.nombre, m.equipo].filter(Boolean).join(' ');
  const e = ESPEC.find(x => x[0].test(t));
  let hp, tanque = null, mod, fuente, cos = /cosech|combine|harvest/i.test((m.tipo || '') + ' ' + t);
  if (e) { mod = e[1]; hp = e[2]; tanque = e[3]; fuente = 'ficha'; cos = cos || e[4] === 'cos'; }
  else { const c = String(m.tipo || '').match(/(\d+)\s*hp\s*to\s*under\s*(\d+)/i), o = String(m.tipo || '').match(/(\d+)\s*hp\s*(?:and|&)\s*(?:over|above)/i);
    if (c) hp = (+c[1] + +c[2]) / 2; else if (o) hp = +o[1] * 1.15; else if (cos) hp = 375; else return null; mod = m.modelo || ''; fuente = 'clase'; }
  const x = cos ? X_COS : (X > 0 ? X : X_TRAC);
  return { mod, hp: Math.round(hp), tanque, fuente, x, lh: +asabe(x, cos ? hp : hp * TDF).toFixed(1), lh_ral: +(hp * 0.7457 * RAL_KW).toFixed(1) };
}
const hoyRDts = ts => new Date(Date.parse(ts) - 4 * 36e5).toISOString().slice(0, 10);
function estimaComb(dia, maq, tq) {
  const E = new Map(maq.map(m => [m.id, m.espec])), T = new Map();
  (tq || []).forEach(r => { if (!T.has(r.id)) T.set(r.id, []); T.get(r.id).push(r); });
  const porTq = new Map();   // id|fecha → litros por bajada de tanque
  T.forEach((L, id) => { const e = E.get(id); if (!e || !e.tanque) return; const g = new Map();
    L.forEach((r, i) => { if (!i) return; const p = L[i - 1], f = hoyRDts(r.ts), d = p.pct - r.pct, h = (Date.parse(r.ts) - Date.parse(p.ts)) / 36e5;
      if (h <= 0 || h > 12) return; const o = g.get(f) || { pct: 0, h: 0 }; if (d > -5) o.pct += d; o.h += h; g.set(f, o); });
    g.forEach((o, f) => { if (o.h >= 3) porTq.set(id + '|' + f, Math.max(0, o.pct) * e.tanque / 100); }); });
  return dia.map(r => { const e = E.get(r.id); if (r.comb > 0 || r.comb24 > 0) return { ...r, comb_met: 'telemetria' };
    const k = porTq.get(r.id + '|' + r.fecha), h = r.horas || 0, ra = Math.min(r.ralenti || 0, h);
    const ph = e ? (h - ra) * e.lh + ra * e.lh_ral : null;
    // el tanque manda cuando hay lecturas suficientes y no es absurdo frente a las horas trabajadas (sensor o llenado parcial)
    if (k != null && (ph == null || (k <= ph * 2.5 + 20 && (h < 1 || k > 0)))) return { ...r, comb_est: +k.toFixed(1), comb_met: 'tanque' };
    if (ph != null && h > 0) return { ...r, comb_est: +ph.toFixed(1), comb_met: 'horas' };
    return r; });
}

// ---- prueba de histórico: endpoints de series de tiempo ISO 15143-3 y horas de operación de Operations Center ----
async function probarHistoria(env) {
  await tablas(env.DB);
  const r = await env.DB.prepare('SELECT data FROM flota_maq').all(), M = (r.results || []).map(x => JSON.parse(x.data)).filter(m => m.pin || m.equipo).slice(0, 2);
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'), fin = new Date(), ini = new Date(Date.now() - 90 * 864e5), A = aemp(env), out = [];
  for (const m of M) {
    const ids = [...new Set([m.pin, m.equipo, m.serie].filter(Boolean))];
    for (const id of ids) for (const t of ['', '/CumulativeOperatingHours', '/OperatingHours', '/CumulativeIdleHours', '/Locations', '/FuelRemaining', '/CumulativeFuelUsed']) {
      const url = `${A}/Fleet/Equipment/ID/${encodeURIComponent(id)}${t}${t ? `/${iso(ini)}/${iso(fin)}/1` : ''}`;
      try { const x = await getJD(env, url, 'application/xml'); out.push({ maquina: m.nombre || m.equipo, id, serie: t || '(ficha)', estado: x.status, bytes: (x.txt || '').length, muestra: (x.txt || '').replace(/\s+/g, ' ').slice(0, 400) }); }
      catch (e) { out.push({ maquina: m.nombre || m.equipo, id, serie: t || '(ficha)', error: String(e.message || e) }); }
    }
    if (m.eq_id) for (const u of [`https://partnerapi.deere.com/platform/machines/${m.eq_id}/hoursOfOperation?startDate=${iso(ini)}&endDate=${iso(fin)}`, `https://partnerapi.deere.com/platform/machines/${m.eq_id}/engineHours`, `https://equipmentapi.deere.com/isg/equipment/${m.eq_id}/engineHours`]) {
      try { const x = await getJD(env, u); out.push({ maquina: m.nombre, serie: u.split('/').pop().split('?')[0], estado: x.status, bytes: (x.txt || '').length, muestra: (x.txt || '').replace(/\s+/g, ' ').slice(0, 400) }); } catch (e) { out.push({ maquina: m.nombre, serie: u, error: String(e.message || e) }); }
    }
  }
  return J({ desde: iso(ini), hasta: iso(fin), pruebas: out });
}

// ---- prueba 2: APIs de máquinas de Operations Center (horas de operación, horas de motor, ubicaciones, alertas) ----
async function probarMaquinas(env) {
  await tablas(env.DB);
  const org = (await env.DB.prepare("SELECT v FROM flota_meta WHERE k='estado'").first()), out = [];
  const st = org ? JSON.parse(org.v) : {};
  const r = await getJD(env, `${EQ}?organizationIds=1750121&itemLimit=3`, 'application/json'), V = (r.json && r.json.values) || [];
  out.push({ paso: 'equipo (crudo)', estado: r.status, muestra: JSON.stringify(V[0] || r.json).slice(0, 1500) });
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'), fin = new Date(), ini = new Date(Date.now() - 30 * 864e5);
  for (const v of V.slice(0, 2)) {
    const cand = [...new Set([v.id, v.principalId, v.legacyId, v.machineId, v.vin, v.serialNumber, ...(((v.links || []).filter(l => /machine/i.test(l.rel || ''))).map(l => String(l.uri).split('/').pop()))].filter(Boolean).map(String))];
    out.push({ paso: 'candidatos de id', equipo: v.name, ids: cand, links: (v.links || []).map(l => l.rel + ' → ' + l.uri) });
    for (const id of cand) for (const [n, u] of [
      ['hoursOfOperation', `https://partnerapi.deere.com/platform/machines/${id}/hoursOfOperation?startDate=${iso(ini)}&endDate=${iso(fin)}`],
      ['engineHours', `https://partnerapi.deere.com/platform/machines/${id}/engineHours`],
      ['locationHistory', `https://partnerapi.deere.com/platform/machines/${id}/locationHistory?startDate=${iso(ini)}&endDate=${iso(fin)}`],
      ['alerts', `https://partnerapi.deere.com/platform/machines/${id}/alerts?startDate=${iso(ini)}&endDate=${iso(fin)}`],
      ['eq engineHours', `https://equipmentapi.deere.com/isg/equipment/${id}/engineHours`],
      ['eq hoursOfOperation', `https://equipmentapi.deere.com/isg/equipment/${id}/hoursOfOperation?startDate=${iso(ini)}&endDate=${iso(fin)}`]]) {
      try { const x = await getJD(env, u); out.push({ equipo: v.name, id, api: n, estado: x.status, bytes: (x.txt || '').length, muestra: (x.txt || '').replace(/\s+/g, ' ').slice(0, 500) }); }
      catch (e) { out.push({ equipo: v.name, id, api: n, error: String(e.message || e) }); }
    }
  }
  return J({ org: st.org, pruebas: out });
}
