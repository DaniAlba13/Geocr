// API de GeoCR (Cloudflare Workers o Pages): guarda los registros compartidos en D1 (binding "DB").
// Rutas:  GET /api/ping · GET /api/me · /api/db/<coleccion>[/<id>] · POST /api/ingest (robot NAX, con token)
const J = (o, s = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
// Colecciones que solo pueden modificar los correos de EDITORES (variable de Cloudflare, separados por coma).
const SOLO_EDITORES = new Set(['lluvia_dia', 'lluvia_mes', 'pluviometros']);
const esEditor = (env, email) => { const l = String(env.EDITORES || '').toLowerCase().split(/[,;\s]+/).filter(Boolean); return !l.length || l.includes(String(email).toLowerCase()); };
const COLL = /^[a-z0-9_]{1,40}$/, ID = /^[A-Za-z0-9_.\-]{1,120}$/;
let listo = false;
async function init(db) {
  if (listo) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, fecha TEXT, upd TEXT, PRIMARY KEY (coll, id))').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS docs_fecha ON docs (coll, fecha)').run();
  listo = true;
}
const setDoc = (db, c, id, txt) => {
  let fecha = ''; try { const d = JSON.parse(txt); fecha = String((d && (d.fecha || d.creado)) || ''); } catch (e) {}
  return db.prepare('INSERT INTO docs (coll,id,data,fecha,upd) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, fecha=excluded.fecha, upd=excluded.upd')
    .bind(c, id, txt, fecha, new Date().toISOString());
};
export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return J({ error: 'Falta conectar la base de datos D1 con el nombre DB (Settings → Bindings).' }, 500);
  await init(db);
  const seg = [].concat(params.path || []), m = request.method;
  const email = request.headers.get('cf-access-authenticated-user-email') || '';

  // --- robot NAX (GitHub Actions): protegido con token, no con Cloudflare Access ---
  if (seg[0] === 'ingest') {
    if (m === 'GET') { // huella corta de la clave, para comparar con GitHub sin revelarla
      const k = String(env.INGEST_TOKEN || '').trim(), h = k ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8) : '';
      return J({ clave_configurada: !!k, largo: k.length, huella: h });
    }
    if (m !== 'POST') return J({ error: 'usa POST' }, 405);
    const tok = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim(), esperado = String(env.INGEST_TOKEN || '').trim();
    if (!esperado || tok !== esperado) return J({ error: 'token inválido' }, 401);
    const { ops = [] } = await request.json(); const out = [], stm = [];
    for (const o of ops) {
      if (!COLL.test(o.coll || '') || !ID.test(o.id || '')) return J({ error: 'colección o id inválido' }, 400);
      if (o.op === 'get') { const r = await db.prepare('SELECT data FROM docs WHERE coll=?1 AND id=?2').bind(o.coll, o.id).first(); out.push(r ? JSON.parse(r.data) : null); }
      else if (o.op === 'set') stm.push(setDoc(db, o.coll, o.id, JSON.stringify(o.data)));
      else if (o.op === 'del') stm.push(db.prepare('DELETE FROM docs WHERE coll=?1 AND id=?2').bind(o.coll, o.id));
    }
    if (stm.length) await db.batch(stm);
    return J({ ok: true, out });
  }

  // --- todo lo demás exige haber entrado por Cloudflare Access ---
  if (!email && env.ALLOW_ANON !== '1') return J({ error: 'Entra por Cloudflare Access.' }, 401);
  if (seg[0] === 'ping') return J({ ok: true });
  if (seg[0] === 'me') return J({ email, editor: esEditor(env, email) });
  if (seg[0] !== 'db') return J({ error: 'ruta desconocida' }, 404);
  const c = seg[1], id = seg[2];
  if (!COLL.test(c || '') || (id !== undefined && !ID.test(id))) return J({ error: 'colección o id inválido' }, 400);
  if (m !== 'GET' && SOLO_EDITORES.has(c) && !esEditor(env, email)) return J({ error: 'Solo el equipo autorizado puede modificar las lluvias.' }, 403);
  if (id === undefined) {
    if (m !== 'GET') return J({ error: 'método no permitido' }, 405);
    const u = new URL(request.url), lim = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '1000', 10) || 1000, 1), 2000);
    const dir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const { results } = await db.prepare(`SELECT id, data FROM docs WHERE coll=?1 ORDER BY fecha ${dir} LIMIT ?2`).bind(c, lim).all();
    return J('[' + results.map(r => '{"id":' + JSON.stringify(r.id) + ',"data":' + r.data + '}').join(',') + ']');
  }
  if (m === 'GET') { const r = await db.prepare('SELECT data FROM docs WHERE coll=?1 AND id=?2').bind(c, id).first(); return r ? J(r.data) : J({ error: 'no existe' }, 404); }
  if (m === 'PUT') { const txt = await request.text(); if (txt.length > 1900000) return J({ error: 'documento muy grande' }, 413); await setDoc(db, c, id, txt).run(); return new Response(null, { status: 204 }); }
  if (m === 'DELETE') { await db.prepare('DELETE FROM docs WHERE coll=?1 AND id=?2').bind(c, id).run(); return new Response(null, { status: 204 }); }
  return J({ error: 'método no permitido' }, 405);
}
