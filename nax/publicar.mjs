// Procesa los CSV del robot con el MISMO motor del tablero (src/nax_engine.js) y publica en GeoCR.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const URL_ = (process.env.GEOCR_URL || '').replace(/\/+$/, ''), TOKEN = (process.env.GEOCR_INGEST_TOKEN || '').trim();
const iso = d => d.toISOString().slice(0, 10);
const DIVN = { 1: 'Higueral', 2: 'Guaymate', 3: 'La Higuera', 4: 'Chavón Abajo', 5: 'Cuyá', 6: 'Lechugas', 7: 'Baigua' };
const motor = fs.readFileSync(path.join(AQUI, '../src/nax_engine.js'), 'utf8');
const E = new Function('iso', 'DIVN', motor + '\nreturn {nxCSV, nxProcesar, nxPack};')(iso, DIVN);
const leer = f => { const p = path.join(AQUI, f); return fs.existsSync(p) && fs.statSync(p).size ? E.nxCSV(fs.readFileSync(p, 'utf8')) : null; };

const F = { hist: leer('historico_actual.csv'), maestro: leer('maestro_lotes.csv'), histAnt: leer('historico_campana_anterior.csv'), maestroAnt: leer('maestro_lotes_campana_anterior.csv') };
if (!F.hist) { console.error('No existe historico_actual.csv: el paso de descarga no trajo datos.'); process.exit(1); }
const snap = E.nxProcesar(F); snap.por = 'Actualización automática diaria';
console.log(`Piezas: ${snap.P.length} · datos del ${snap.rango[0]} al ${snap.rango[1]} · maestro: ${snap.maestro ? 'sí' : 'no'} · campaña anterior: ${snap.ant ? 'sí' : 'no'}`);
if (process.argv.includes('--solo-probar')) process.exit(0);
if (!URL_ || !TOKEN) { console.error('Faltan GEOCR_URL (variable) o GEOCR_INGEST_TOKEN (secret) en GitHub.'); process.exit(1); }

const CH = 180000, js = JSON.stringify(E.nxPack(snap)), partes = [];
for (let i = 0; i < js.length; i += CH) partes.push(js.slice(i, i + CH));
const pdfRuta = path.join(AQUI, 'reporte_nax.pdf'), pdf = fs.existsSync(pdfRuta) ? fs.readFileSync(pdfRuta).toString('base64') : '', pp = [];
for (let i = 0; i < pdf.length; i += CH) pp.push(pdf.slice(i, i + CH));

async function ops(lista) {
  const r = await fetch(URL_ + '/api/ingest', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ ops: lista }) });
  if (r.status >= 300 && r.status < 400) throw new Error('Cloudflare Access bloqueó /api/ingest: falta la regla "Bypass" para esa ruta (ver README).');
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { throw new Error(`Respuesta inesperada (${r.status}): ${t.slice(0, 200)}`); }
  if (r.status === 401) throw new Error('GeoCR rechazó la clave: GEOCR_INGEST_TOKEN (GitHub) no es igual a INGEST_TOKEN (Cloudflare). Vuelve a pegar la misma clave en los dos lugares.');
  if (!r.ok) throw new Error(`GeoCR respondió ${r.status}: ${j.error || t.slice(0, 200)}`);
  return j.out;
}
const [prev] = await ops([{ op: 'get', coll: 'nax_meta', id: 'actual' }]);
const sid = 's' + Date.now();
for (let i = 0; i < partes.length; i++) await ops([{ op: 'set', coll: 'nax_snap', id: `${sid}-${i}`, data: { i, s: partes[i] } }]);
for (let i = 0; i < pp.length; i++) await ops([{ op: 'set', coll: 'nax_snap', id: `${sid}-pdf-${i}`, data: { i, s: pp[i] } }]);
await ops([{ op: 'set', coll: 'nax_meta', id: 'actual', data: { sid, parts: partes.length, pdf: pp.length, fecha: snap.fecha, rango: snap.rango, por: snap.por } }]);
if (prev && prev.sid) {
  const del = [];
  for (let i = 0; i < (prev.parts || 0); i++) del.push({ op: 'del', coll: 'nax_snap', id: `${prev.sid}-${i}` });
  for (let i = 0; i < (prev.pdf || 0); i++) del.push({ op: 'del', coll: 'nax_snap', id: `${prev.sid}-pdf-${i}` });
  for (let i = 0; i < del.length; i += 50) await ops(del.slice(i, i + 50));
}
console.log(`Publicado en GeoCR: ${partes.length} partes de datos${pp.length ? ` y el PDF (${pp.length} partes)` : ''}.`);
