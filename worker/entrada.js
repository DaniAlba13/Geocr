// Entrada propia de AgroAP-CR (sin código por correo).
//  · Si Cloudflare Access está delante, se usa su correo como siempre.
//  · Si no, la persona escribe su correo en /entrar; solo pasa si está en la variable USUARIOS (correos separados por coma)
//    y, si existe la variable CLAVE, si además escribe esa clave. Queda una cookie firmada (HMAC) por 90 días.
//  · El encabezado de correo de Access que mande el navegador se descarta si no viene de Access (no se puede falsificar).
const COOKIE = 'agroap_ses', DIAS = 90;
const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const secreto = env => String(env.SESSION_SECRET || env.INGEST_TOKEN || '').trim();
async function firma(env, txt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(txt)));
}
const lista = env => String(env.USUARIOS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
const cookieDe = (req, n) => ((req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(n + '=')) || '').slice(n.length + 1);

export async function correoSesion(request, env) {
  if (request.headers.get('cf-access-jwt-assertion')) return request.headers.get('cf-access-authenticated-user-email') || '';
  const v = decodeURIComponent(cookieDe(request, COOKIE) || '');
  const [email, exp, sig] = v.split('|');
  if (!email || !exp || !sig || !secreto(env) || Date.now() > +exp) return '';
  if (sig !== await firma(env, email + '|' + exp)) return '';
  return lista(env).includes(email) ? email : '';      // si lo sacas de USUARIOS, pierde el acceso al instante
}

const pagina = (msg, conClave) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgroAP-CR · Entrar</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,'Segoe UI',Arial,sans-serif;background:radial-gradient(circle at 20% 10%,#1d5fc2,transparent 45%),linear-gradient(135deg,#0E2A47,#0a3f8f)}
.c{background:#fff;border-radius:14px;padding:36px 34px;width:min(92vw,400px);box-shadow:0 20px 60px rgba(0,0,0,.35)}h1{margin:0;font-size:34px;color:#0E2A47;letter-spacing:-1px}h1 span{color:#0070C9}h1 em{color:#EE3B33;font-style:normal}
p{color:#5b6673;font-size:14px;margin:6px 0 22px}label{display:block;font-size:12px;font-weight:700;color:#0E2A47;letter-spacing:.04em;text-transform:uppercase;margin:14px 0 6px}
input{width:100%;padding:12px 14px;border:1px solid #cfd6df;border-radius:8px;font-size:15px}input:focus{outline:2px solid #0070C9;border-color:#0070C9}
button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:8px;background:#0070C9;color:#fff;font-size:15px;font-weight:700;cursor:pointer}button:hover{background:#005ea8}
.e{background:#fdecea;color:#b3261e;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:6px}small{display:block;margin-top:16px;color:#8a94a2;font-size:12px;text-align:center}</style></head>
<body><form class="c" method="post" action="/entrar"><h1>Agro<span>AP</span>-<em>CR</em></h1><p>Agricultura de Precisión · Central Romana</p>${msg ? `<div class="e">${msg}</div>` : ''}
<label for="e">Correo</label><input id="e" name="email" type="email" required autocomplete="email" autofocus>
${conClave ? '<label for="k">Clave</label><input id="k" name="clave" type="password" required autocomplete="current-password">' : ''}
<button type="submit">Entrar</button><small>Solo correos autorizados por el Área de Agricultura de Precisión.</small></form></body></html>`;
const html = (h, st = 200, extra = {}) => new Response(h, { status: st, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export async function rutaEntrada(request, env, url) {
  const conClave = !!String(env.CLAVE || '').trim();
  if (url.pathname === '/salir') return new Response(null, { status: 302, headers: { location: '/entrar', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  if (url.pathname !== '/entrar') return null;
  if (request.method !== 'POST') return html(pagina('', conClave));
  const f = await request.formData(), email = String(f.get('email') || '').trim().toLowerCase(), clave = String(f.get('clave') || '');
  if (!secreto(env)) return html(pagina('La plataforma no tiene configurada la firma de sesión.', conClave), 500);
  if (!lista(env).includes(email) || (conClave && clave !== String(env.CLAVE).trim())) {
    await new Promise(r => setTimeout(r, 600));           // frena intentos repetidos
    return html(pagina('Ese correo no está autorizado' + (conClave ? ' o la clave no es correcta' : '') + '.', conClave), 403);
  }
  const exp = Date.now() + DIAS * 864e5, v = encodeURIComponent(`${email}|${exp}|${await firma(env, email + '|' + exp)}`);
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=${v}; Path=/; Max-Age=${DIAS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
}

export const paginaEntrada = env => html(pagina('', !!String(env.CLAVE || '').trim()));
