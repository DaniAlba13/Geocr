// Historial de la flota John Deere (APIs de máquinas de Operations Center, ya aprobadas):
//  · hoursOfOperation → períodos de motor encendido/apagado → horas por día (flota_op, flota_hdia)
//  · locationHistory  → posiciones GPS (flota_loc)
//  · alerts           → alertas de diagnóstico (DTC) de John Deere (flota_alerta)
// Se carga por partes con un cron cada 5 minutos (máximo ~35 llamadas a John Deere por corrida) hasta
// completar 6 meses hacia atrás; después solo se actualiza lo nuevo cada pocas horas.
import { getJD } from './jd.js';

const API = 'https://partnerapi.deere.com/platform/machines/';
const MESES = 6, POR_CORRIDA = 15, REFRESCO_H = 6, CUPO_DIA = 35000;   // CUPO_DIA: filas máximas que escribe el historial por día (plan gratuito de D1: 100 000 escrituras/día en total)
const iso = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const diaRD = t => new Date(Date.parse(t) - 4 * 36e5).toISOString().slice(0, 10);
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export async function tablasHist(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS flota_job (k TEXT PRIMARY KEY, id TEXT, mid TEXT, tipo TEXT, url TEXT, hasta TEXT, estado TEXT, n INTEGER DEFAULT 0, err TEXT, upd TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_op (id TEXT NOT NULL, ini TEXT NOT NULL, fin TEXT, encendido INTEGER, det TEXT, PRIMARY KEY (id, ini))'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_hdia (id TEXT NOT NULL, fecha TEXT NOT NULL, horas REAL, PRIMARY KEY (id, fecha))'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_loc (id TEXT NOT NULL, ts TEXT NOT NULL, lat REAL, lon REAL, PRIMARY KEY (id, ts))'),
    db.prepare('CREATE TABLE IF NOT EXISTS flota_alerta (id TEXT NOT NULL, ts TEXT NOT NULL, cod TEXT NOT NULL, color TEXT, descr TEXT, horas REAL, data TEXT, PRIMARY KEY (id, ts, cod))'),
  ]);
}

const url0 = (mid, tipo, desde, hasta) => `${API}${mid}/${tipo}?startDate=${iso(desde)}&endDate=${iso(hasta)}&itemLimit=100`;
const tipos = ['hoursOfOperation', 'alerts'];   // los recorridos GPS (locationHistory) no se cargan hacia atrás: son demasiadas filas para el plan gratuito

// crea o reactiva los trabajos de cada máquina
async function planificar(env) {
  const db = env.DB, ahora = Date.now();
  const M = ((await db.prepare('SELECT id, data FROM flota_maq').all()).results || []).map(r => JSON.parse(r.data)).filter(m => m.eq_id);
  const J0 = new Map(((await db.prepare('SELECT * FROM flota_job').all()).results || []).map(j => [j.k, j]));
  const st = [];
  for (const m of M) for (const t of tipos) {
    const k = m.id + '|' + t, j = J0.get(k);
    if (!j) st.push(db.prepare('INSERT INTO flota_job (k,id,mid,tipo,url,hasta,estado,upd) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
      .bind(k, m.id, String(m.eq_id), t, url0(m.eq_id, t, ahora - MESES * 30.5 * 864e5, ahora), iso(ahora), 'pendiente', iso(ahora)));
    else if (j.estado === 'ok' && ahora - Date.parse(j.upd) > REFRESCO_H * 36e5)   // actualizar lo nuevo
      st.push(db.prepare("UPDATE flota_job SET url=?2, hasta=?3, estado='pendiente', upd=?4 WHERE k=?1").bind(k, url0(j.mid, t, Date.parse(j.hasta) - 36e5, ahora), iso(ahora), iso(ahora)));
  }
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}

const encendido = v => v.engineState === 1 || v.engineState === '1' || v.engineState === true || /^on$|running|engine on/i.test(String(v.engineState ?? '')) ? 1 : 0;
const tsDe = v => v.eventTimestamp || v.gpsFixTimestamp || v.timestamp || v.time || v.reportTime || v.occurrenceTime || v.dateTime ||
  (Array.isArray(v.eventTimes) && v.eventTimes[0] && (v.eventTimes[0].eventTimestamp || v.eventTimes[0].time || v.eventTimes[0])) || null;

async function guardar(env, j, V) {
  const db = env.DB, st = [];
  if (j.tipo === 'hoursOfOperation') {
    const dias = new Set();
    V.forEach(v => { if (!v.startDate) return; st.push(db.prepare('INSERT OR REPLACE INTO flota_op (id,ini,fin,encendido,det) VALUES (?1,?2,?3,?4,?5)')
      .bind(j.id, v.startDate, v.endDate || null, encendido(v), String(v.detailedState || v.engineState || '').slice(0, 60)));
      for (let t = Date.parse(v.startDate) - 4 * 36e5, f = Date.parse(v.endDate || v.startDate) - 4 * 36e5; t <= f + 1; t += 864e5) dias.add(new Date(t).toISOString().slice(0, 10)); });
    for (let i = 0; i < st.length; i += 80) await db.batch(st.slice(i, i + 80));
    // horas encendida por día (hora RD), recalculadas desde los períodos guardados: idempotente
    for (const f of dias) {
      const a = Date.parse(f + 'T04:00:00Z'), b = a + 864e5;
      const r = (await db.prepare('SELECT ini, fin FROM flota_op WHERE id=?1 AND encendido=1 AND ini < ?3 AND (fin IS NULL OR fin > ?2)').bind(j.id, iso(a), iso(b)).all()).results || [];
      const h = r.reduce((s, x) => s + Math.max(0, Math.min(b, Date.parse(x.fin || x.ini)) - Math.max(a, Date.parse(x.ini))), 0) / 36e5;
      await db.prepare('INSERT OR REPLACE INTO flota_hdia (id,fecha,horas) VALUES (?1,?2,?3)').bind(j.id, f, +h.toFixed(2)).run();
    }
    return;
  }
  if (j.tipo === 'locationHistory') V.forEach(v => { const p = v.point || v.location || v, ts = tsDe(v); if (ts && p.lat != null && p.lon != null)
    st.push(db.prepare('INSERT OR IGNORE INTO flota_loc (id,ts,lat,lon) VALUES (?1,?2,?3,?4)').bind(j.id, String(ts), +p.lat, +p.lon)); });
  if (j.tipo === 'alerts') V.forEach(v => { const d = v.definition || {}, ts = tsDe(v); if (!ts) return;
    const cod = [d.spn ?? v.spn, d.fmi ?? v.fmi].filter(x => x != null).join('.') || String(d.id || v.id || d.code || d.name || '?');
    const descr = d.description || d.name || d.title || v.description || '';
    const h = v.engineHours && (v.engineHours.reading ? v.engineHours.reading.valueAsDouble : v.engineHours.valueAsDouble);
    st.push(db.prepare('INSERT OR IGNORE INTO flota_alerta (id,ts,cod,color,descr,horas,data) VALUES (?1,?2,?3,?4,?5,?6,?7)')
      .bind(j.id, String(ts), cod.slice(0, 60), String(v.color || d.color || v.severity || '').toUpperCase(), String(descr).slice(0, 300), h ?? null,
        JSON.stringify({ bus: v.bus, ack: v.acknowledgementStatus, sev: v.severity || d.severity, src: d.sourceAddress ?? v.sourceAddress, ...((d.threeLetterAcronym || d.tla) ? { tla: d.threeLetterAcronym || d.tla } : {}) }).slice(0, 400)));
  });
  for (let i = 0; i < st.length; i += 80) await db.batch(st.slice(i, i + 80));
}

// una corrida del cron: avanza los trabajos pendientes
export async function avanzarHistoria(env) {
  const db = env.DB; await tablasHist(db); await planificar(env);
  await db.prepare("UPDATE flota_job SET estado='pendiente' WHERE estado='error' AND err LIKE '404%No Equipments%' AND upd < ?1").bind(iso(Date.now() - 6 * 36e5)).run();   // reintento cada 6 h
  const P = (await db.prepare("SELECT * FROM flota_job WHERE estado='pendiente' ORDER BY CASE tipo WHEN 'hoursOfOperation' THEN 0 WHEN 'alerts' THEN 1 ELSE 2 END, k LIMIT 40").all()).results || [];
  await db.prepare("DELETE FROM flota_job WHERE tipo='locationHistory'").run();
  const hoy = new Date().toISOString().slice(0, 10), c0 = await db.prepare("SELECT v FROM flota_meta WHERE k='hist_cupo'").first().catch(() => null);
  let cupo = c0 ? JSON.parse(c0.v) : { d: hoy, n: 0 }; if (cupo.d !== hoy) cupo = { d: hoy, n: 0 };
  if (cupo.n >= CUPO_DIA) return { llamadas: 0, pausa: 'cupo diario de escritura alcanzado (' + cupo.n + ' filas); sigue mañana' };
  const guardaCupo = () => db.prepare("INSERT OR REPLACE INTO flota_meta (k,v) VALUES ('hist_cupo',?1)").bind(JSON.stringify(cupo)).run();
  let llamadas = 0;
  for (const j of P) {
    let url = j.url, n = j.n || 0;
    while (url && llamadas < POR_CORRIDA && cupo.n < CUPO_DIA) {
      llamadas++;
      let r; try { r = await getJD(env, url); } catch (e) { await db.prepare("UPDATE flota_job SET err=?2, upd=?3 WHERE k=?1").bind(j.k, String(e.message || e).slice(0, 200), iso(Date.now())).run(); return { llamadas, error: String(e.message || e) }; }
      if (r.status === 429) { await guardaCupo(); return { llamadas, pausa: 'John Deere pidió esperar (429)' }; }
      if (r.status === 404 && /No Equipments found/i.test(r.txt || '') && !j._re) {   // id de equipo distinto: buscarlo por número de serie
        j._re = 1; llamadas++;
        const q = await getJD(env, `https://equipmentapi.deere.com/isg/equipment?organizationIds=1750121&serialNumbers=${encodeURIComponent(j.id)}`, 'application/json').catch(() => null);
        const v = q && q.json && (q.json.values || []).find(x => String(x.id) !== String(j.mid));
        if (v) { url = url.replace(`/machines/${j.mid}/`, `/machines/${v.id}/`); await db.prepare('UPDATE flota_job SET mid=?2, url=?3 WHERE k=?1').bind(j.k, String(v.id), url).run(); j.mid = String(v.id); continue; }
      }
      if (r.status !== 200) { await db.prepare("UPDATE flota_job SET estado='error', err=?2, upd=?3 WHERE k=?1").bind(j.k, (r.status + ' ' + (r.txt || '')).slice(0, 200), iso(Date.now())).run(); url = null; break; }
      const V = (r.json && r.json.values) || []; await guardar(env, j, V); n += V.length; cupo.n += V.length + 4;
      const nx = ((r.json && r.json.links) || []).find(l => l.rel === 'nextPage'); url = nx ? nx.uri : null;
      await db.prepare('UPDATE flota_job SET url=?2, n=?3, estado=?4, err=NULL, upd=?5 WHERE k=?1').bind(j.k, url, n, url ? 'pendiente' : 'ok', iso(Date.now())).run();
    }
    if (llamadas >= POR_CORRIDA || cupo.n >= CUPO_DIA) break;
  }
  await guardaCupo();
  return { llamadas, filas_hoy: cupo.n };
}

// avance de la carga, para mostrar en el tablero
export async function estadoHistoria(env) {
  await tablasHist(env.DB);
  const r = (await env.DB.prepare("SELECT tipo, estado, COUNT(*) n, SUM(n) reg FROM flota_job GROUP BY tipo, estado").all()).results || [];
  return r;
}

// alertas de diagnóstico agrupadas por máquina y código en un rango de fechas
export async function alertasJD(env, desde, hasta, id) {
  await tablasHist(env.DB);
  const q = 'SELECT id, cod, color, descr, COUNT(*) veces, MIN(ts) primera, MAX(ts) ultima, MAX(horas) horas FROM flota_alerta WHERE ts >= ?1 AND ts < ?2' + (id ? ' AND id = ?3' : '') + ' GROUP BY id, cod, color, descr ORDER BY ultima DESC';
  const s = env.DB.prepare(q), r = id ? s.bind(desde, hasta, id) : s.bind(desde, hasta);
  return (await r.all()).results || [];
}

// horas por día del historial (para los días que la telemetría propia no cubre)
export async function horasHist(env, desde) {
  await tablasHist(env.DB);
  return ((await env.DB.prepare('SELECT id, fecha, horas FROM flota_hdia WHERE fecha >= ?1').bind(desde).all()).results) || [];
}

export async function muestraHist(env) {
  await tablasHist(env.DB);
  const q = s => env.DB.prepare(s).all().then(r => r.results || []);
  return J({ trabajos: await estadoHistoria(env), errores: await q("SELECT k, err FROM flota_job WHERE estado='error' LIMIT 10"),
    op: await q('SELECT * FROM flota_op ORDER BY ini DESC LIMIT 5'), hdia: await q('SELECT * FROM flota_hdia ORDER BY fecha DESC LIMIT 5'),
    loc: await q('SELECT * FROM flota_loc ORDER BY ts DESC LIMIT 3'), alertas: await q('SELECT * FROM flota_alerta ORDER BY ts DESC LIMIT 5') });
}
