// Conexión con John Deere Operations Center (OAuth2 de tres pasos), primera etapa: conectar y comprobar.
//  · /jd           → página de estado con el botón "Conectar John Deere".
//  · /jd/conectar  → lleva al inicio de sesión de John Deere.
//  · /jd/callback  → John Deere vuelve aquí (única dirección registrada en developer.deere.com).
//  · /jd/salir     → borra la conexión guardada.
// Secrets en Cloudflare: JD_CLIENT_ID, JD_CLIENT_SECRET. Variables opcionales: JD_API (base de la API), JD_SCOPES.
// Los tokens se guardan en la tabla jd_tokens de D1, que la API /api/db no expone.
const WELL_KNOWN = 'https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/.well-known/oauth-authorization-server';
const ACCEPT = 'application/vnd.deere.axiom.v3+json';
const api = env => String(env.JD_API || 'https://sandboxapi.deere.com/platform').replace(/\/+$/, '');
const scopes = env => String(env.JD_SCOPES || 'org1 eq1 offline_access');
const retorno = url => url.origin + '/jd/callback';
const ST = 'agroap_jd_state';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cookieDe = (req, n) => ((req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(n + '=')) || '').slice(n.length + 1);

let meta = null;
async function servidor() {
  if (meta) return meta;
  const r = await fetch(WELL_KNOWN);
  if (!r.ok) throw new Error('No se pudo leer la configuración de John Deere (' + r.status + ').');
  return (meta = await r.json());
}
async function tabla(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS jd_tokens (id TEXT PRIMARY KEY, data TEXT NOT NULL, upd TEXT)').run();
}
async function leerTok(db) {
  await tabla(db);
  const r = await db.prepare("SELECT data FROM jd_tokens WHERE id='org'").first();
  return r ? JSON.parse(r.data) : null;
}
async function guardarTok(db, t) {
  await tabla(db);
  await db.prepare("INSERT INTO jd_tokens (id,data,upd) VALUES ('org',?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data, upd=excluded.upd")
    .bind(JSON.stringify(t), new Date().toISOString()).run();
}
async function pedirToken(env, cuerpo) {
  const m = await servidor();
  const r = await fetch(m.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
      authorization: 'Basic ' + btoa(String(env.JD_CLIENT_ID).trim() + ':' + String(env.JD_CLIENT_SECRET).trim()) },
    body: new URLSearchParams(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('John Deere no entregó el token: ' + (j.error_description || j.error || r.status));
  return j;
}
// Token vigente; si venció, lo renueva con el refresh token (y guarda el nuevo).
export async function tokenJD(env) {
  const t = await leerTok(env.DB);
  if (!t) return null;
  if (t.exp && Date.now() < t.exp - 120e3) return t.access_token;
  const j = await pedirToken(env, { grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: scopes(env) });
  const n = { access_token: j.access_token, refresh_token: j.refresh_token || t.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope || t.scope, desde: t.desde, por: t.por };
  await guardarTok(env.DB, n);
  return n.access_token;
}
export async function getJD(env, ruta) {
  const tok = await tokenJD(env);
  if (!tok) throw new Error('John Deere no está conectado.');
  const u = /^https?:/.test(ruta) ? ruta : api(env) + ruta;
  const r = await fetch(u, { headers: { authorization: 'Bearer ' + tok, accept: ACCEPT } });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json: j, txt };
}
const link = (o, rel) => ((o && o.links) || []).find(l => l.rel === rel);

const pagina = (cuerpo) => new Response(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgroAP-CR · John Deere</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiI+PHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIHJ4PSIxMDQiIGZpbGw9IiMwRTJBNDciLz48ZyBpZD0ibWFyY2EiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE2IDgpIj4KICA8cmVjdCB4PSIxMDQiIHk9IjMwMCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iOCIgZmlsbD0iIzAwNzBDOSIgb3BhY2l0eT0iLjIyIi8+CiAgPHJlY3QgeD0iMTA0IiB5PSIzNTgiIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgcng9IjgiIGZpbGw9IiMwMDcwQzkiIG9wYWNpdHk9Ii41Ii8+CiAgPHJlY3QgeD0iMTYyIiB5PSIzMDAiIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgcng9IjgiIGZpbGw9IiMwMDcwQzkiIG9wYWNpdHk9Ii41Ii8+CiAgPHJlY3QgeD0iMTYyIiB5PSIzNTgiIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgcng9IjgiIGZpbGw9IiMwMDcwQzkiIG9wYWNpdHk9Ii44NSIvPgogIDxyZWN0IHg9IjE2MiIgeT0iMjQyIiB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHJ4PSI4IiBmaWxsPSIjMDA3MEM5IiBvcGFjaXR5PSIuMjIiLz4KICA8cmVjdCB4PSIyMjAiIHk9IjM1OCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iOCIgZmlsbD0iIzAwNzBDOSIgb3BhY2l0eT0iLjUiLz4KICA8ZyBmaWxsPSIjRkZGRkZGIj4KICAgIDxyZWN0IHg9IjIzOCIgeT0iMzIyIiB3aWR0aD0iMzYiIGhlaWdodD0iODYiIHJ4PSIxMSIvPgogICAgPHJlY3QgeD0iMjQwIiB5PSIyMzIiIHdpZHRoPSIzNiIgaGVpZ2h0PSI4MiIgcng9IjExIiB0cmFuc2Zvcm09InJvdGF0ZSg0IDI1OCAyNzMpIi8+CiAgICA8cmVjdCB4PSIyNDYiIHk9IjE0NiIgd2lkdGg9IjM0IiBoZWlnaHQ9Ijc4IiByeD0iMTEiIHRyYW5zZm9ybT0icm90YXRlKDggMjYzIDE4NSkiLz4KICAgIDxwYXRoIGQ9Ik0yNzIgMjQ4IFEzMzYgMTk2IDQwNCAyMDYgUTM0MiAyMjYgMjc4IDI3OCBaIi8+CiAgICA8cGF0aCBkPSJNMjQ0IDMyNiBRMTg0IDI3OCAxMjYgMjgyIFExODIgMzAyIDIzOCAzNTQgWiIvPgogICAgPHBhdGggZD0iTTI2NiAxNzYgUTI3MiAxMjIgMzA0IDk0IFEyOTIgMTMyIDI4NiAxODIgWiIvPgogIDwvZz4KICA8ZyBmaWxsPSJub25lIiBzdHJva2U9IiNFRTNCMzMiIHN0cm9rZS13aWR0aD0iOSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj4KICAgIDxwYXRoIGQ9Ik0zOTIgMTY4IEEgNTIgNTIgMCAwIDEgMzQwIDExNiIgb3BhY2l0eT0iLjYiLz4KICAgIDxwYXRoIGQ9Ik0zOTIgMTk2IEEgODAgODAgMCAwIDEgMzEyIDExNiIgb3BhY2l0eT0iLjMiLz4KICA8L2c+CiAgPGNpcmNsZSBjeD0iMzkyIiBjeT0iMTE2IiByPSIyNyIgZmlsbD0iI0VFM0IzMyIvPgogIDxjaXJjbGUgY3g9IjM5MiIgY3k9IjExNiIgcj0iMTAiIGZpbGw9IiMwRTJBNDciLz4KPC9nPjwvc3ZnPg==">
<style>*{box-sizing:border-box}body{margin:0;font-family:Inter,'Segoe UI',Arial,sans-serif;background:#f3f6f9;color:#1d2733}
header{background:#0E2A47;color:#fff;padding:14px 22px;font-weight:700;font-size:18px}header a{color:#9cc7f0;font-size:13px;font-weight:400;margin-left:14px;text-decoration:none}
main{max-width:980px;margin:22px auto;padding:0 16px}.c{background:#fff;border:1px solid #dde3ea;border-radius:12px;padding:18px 20px;margin-bottom:14px}
h2{margin:0 0 10px;font-size:16px;color:#0E2A47}.b{display:inline-block;padding:11px 18px;border-radius:8px;background:#0070C9;color:#fff;text-decoration:none;font-weight:700;font-size:14px}
.b.g{background:#fff;color:#0E2A47;border:1px solid #cfd6df}.ok{color:#1b7f3b;font-weight:700}.mal{color:#b3261e;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eef1f4}th{color:#5b6673;font-weight:600}
small,.m{color:#5b6673;font-size:12px}pre{background:#f6f8fa;border-radius:8px;padding:10px;font-size:11px;overflow:auto;max-height:260px}</style></head>
<body><header>AgroAP-CR · John Deere <a href="/">← volver a la plataforma</a></header><main>${cuerpo}</main></body></html>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

async function estado(env, url) {
  if (!env.JD_CLIENT_ID || !env.JD_CLIENT_SECRET) return pagina('<div class="c"><h2>Falta configurar</h2><p class="mal">No encuentro los secrets JD_CLIENT_ID y JD_CLIENT_SECRET en Cloudflare.</p></div>');
  const t = await leerTok(env.DB);
  if (!t) return pagina(`<div class="c"><h2>John Deere no está conectado</h2><p>Al conectar, te lleva a la página de John Deere: entras con tu usuario de Operations Center y aceptas el acceso de AgroAP-CR (solo lectura).</p><a class="b" href="/jd/conectar">Conectar John Deere</a></div>`);
  let h = `<div class="c"><h2><span class="ok">● Conectado</span></h2><p class="m">Conectado por ${esc(t.por || '—')} el ${esc((t.desde || '').slice(0, 16).replace('T', ' '))} · permisos: ${esc(t.scope || '')} · servidor: ${esc(api(env))}</p>
  <a class="b g" href="/jd/conectar">Volver a conectar</a> <a class="b g" href="/jd/salir" onclick="return confirm('¿Desconectar John Deere de la plataforma?')">Desconectar</a></div>`;
  const o = await getJD(env, '/organizations');
  if (o.status !== 200) return pagina(h + `<div class="c"><h2>Organizaciones</h2><p class="mal">John Deere respondió ${o.status}.</p><pre>${esc(o.txt.slice(0, 1500))}</pre></div>`);
  const orgs = (o.json && o.json.values) || [];
  h += `<div class="c"><h2>Organizaciones (${orgs.length})</h2><table><tr><th>Nombre</th><th>ID</th><th>Acceso de AgroAP-CR</th></tr>`;
  for (const g of orgs) {
    const con = link(g, 'connections');
    h += `<tr><td>${esc(g.name)}</td><td>${esc(g.id)}</td><td>${con ? `<a class="b" href="${esc(con.uri + (/[?&]redirect_uri=/.test(con.uri) ? '' : (con.uri.includes('?') ? '&' : '?') + 'redirect_uri=' + encodeURIComponent(retorno(url))))}">Aprobar acceso</a>` : '<span class="ok">Aprobado</span>'}</td></tr>`;
  }
  h += '</table></div>';
  for (const g of orgs.filter(g => !link(g, 'connections'))) {
    const m = await getJD(env, `/organizations/${encodeURIComponent(g.id)}/machines`);
    const vals = (m.json && m.json.values) || [];
    h += `<div class="c"><h2>Máquinas de ${esc(g.name)} ${m.json && m.json.total != null ? '(' + m.json.total + ')' : ''}</h2>`;
    if (m.status !== 200) { h += `<p class="mal">John Deere respondió ${m.status}.</p><pre>${esc(m.txt.slice(0, 1500))}</pre></div>`; continue; }
    h += '<table><tr><th>Nombre</th><th>Modelo</th><th>Serie (VIN)</th><th>Tipo</th><th>ID</th></tr>';
    for (const x of vals.slice(0, 60)) {
      const md = x.equipmentModel || x.model || {}, tp = x.equipmentType || x.machineType || {};
      h += `<tr><td>${esc(x.name)}</td><td>${esc(md.name || md)}</td><td>${esc(x.vin || x.serialNumber || '')}</td><td>${esc(tp.name || tp)}</td><td>${esc(x.id)}</td></tr>`;
    }
    h += `</table>${vals.length > 60 ? '<p class="m">Se muestran las primeras 60.</p>' : ''}<p class="m">Estructura de la primera máquina (para armar el tablero):</p><pre>${esc(JSON.stringify(vals[0] || {}, null, 1).slice(0, 3000))}</pre></div>`;
  }
  return pagina(h);
}

// email: correo de la sesión (ya validado por index.js).
export async function rutaJD(request, env, url, email) {
  const p = url.pathname.replace(/\/+$/, '');
  try {
    if (p === '/jd') return await estado(env, url);
    if (p === '/jd/conectar') {
      if (!env.JD_CLIENT_ID) return estado(env, url);
      const m = await servidor(), st = crypto.randomUUID();
      const q = new URLSearchParams({ response_type: 'code', client_id: String(env.JD_CLIENT_ID).trim(), redirect_uri: retorno(url), scope: scopes(env), state: st });
      return new Response(null, { status: 302, headers: { location: m.authorization_endpoint + '?' + q,
        'set-cookie': `${ST}=${st}; Path=/jd; Max-Age=900; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (p === '/jd/callback') {
      const code = url.searchParams.get('code'), err = url.searchParams.get('error');
      if (err) return pagina(`<div class="c"><h2 class="mal">John Deere no autorizó la conexión</h2><p>${esc(url.searchParams.get('error_description') || err)}</p><a class="b" href="/jd">Volver</a></div>`);
      if (!code) return new Response(null, { status: 302, headers: { location: '/jd' } });   // regreso tras aprobar la organización
      if (!url.searchParams.get('state') || url.searchParams.get('state') !== cookieDe(request, ST))
        return pagina('<div class="c"><h2 class="mal">La conexión expiró o no coincide</h2><p>Vuelve a intentarlo.</p><a class="b" href="/jd/conectar">Conectar John Deere</a></div>');
      const j = await pedirToken(env, { grant_type: 'authorization_code', code, redirect_uri: retorno(url) });
      if (!j.refresh_token) return pagina('<div class="c"><h2 class="mal">Falta el permiso offline_access</h2><p>Sin él la plataforma no puede renovar la conexión sola.</p></div>');
      await guardarTok(env.DB, { access_token: j.access_token, refresh_token: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope || scopes(env), desde: new Date().toISOString(), por: email });
      return new Response(null, { status: 302, headers: { location: '/jd', 'set-cookie': `${ST}=; Path=/jd; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (p === '/jd/salir') {
      await tabla(env.DB); await env.DB.prepare("DELETE FROM jd_tokens WHERE id='org'").run();
      return new Response(null, { status: 302, headers: { location: '/jd' } });
    }
  } catch (e) {
    return pagina(`<div class="c"><h2 class="mal">Error</h2><p>${esc(e && e.message || e)}</p><a class="b" href="/jd">Volver</a></div>`);
  }
  return null;
}
