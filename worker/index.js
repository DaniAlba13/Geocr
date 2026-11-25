// Worker de GeoCR: /api/* va a la API (base de datos D1); todo lo demás es la página en public/.
import { onRequest } from './api.js';
import { dispararRobot } from './robot.js';
import { correoSesion, rutaEntrada, paginaEntrada } from './entrada.js';
import { rutaJD } from './jd.js';
import { rutaFlota, rutaPBI, syncFlota } from './flota.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const r0 = await rutaEntrada(request, env, url);
    if (r0) return r0;
    if (url.pathname.startsWith('/pbi/')) return rutaPBI(request, env, url);   // Power BI: clave PBI_KEY, sin sesión
    const path = url.pathname.startsWith('/api/') ? url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent) : null;
    const email = await correoSesion(request, env);
    // El robot (/api/ingest) usa su propio token; todo lo demás exige sesión (Cloudflare Access o la entrada propia).
    if (!email && !(path && path[0] === 'ingest') && env.ALLOW_ANON !== '1') {
      if (path) return new Response(JSON.stringify({ error: 'Entra con tu correo autorizado.', entrar: '/entrar' }), { status: 401, headers: { 'content-type': 'application/json' } });
      return paginaEntrada(env);
    }
    if (url.pathname === '/jd' || url.pathname.startsWith('/jd/')) {
      const r = await rutaJD(request, env, url, email);
      if (r) return r;
    }
    if (path && path[0] === 'flota') {
      try { return await rutaFlota(request, env, path); }
      catch (e) { return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }
    if (path) {
      const h = new Headers(request.headers);
      h.delete('cf-access-authenticated-user-email');
      if (email) h.set('cf-access-authenticated-user-email', email);
      request = new Request(request, { headers: h });
      try {
        return await onRequest({ request, env, params: { path } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
  // Cron de Cloudflare (ver "triggers" en wrangler.jsonc): dispara el robot NAX a la hora exacta.
  //  · "0 * * * *": cada hora sincroniza la flota John Deere; a las 10:00 y 18:00 UTC (6 a. m. y 2 p. m. RD) lanza el robot NAX.
  //  · "30 11 * * *" y "30 19 * * *": respaldo del robot NAX.
  async scheduled(event, env, ctx) {
    if (event.cron === '0 * * * *') {
      const H = new Date(event.scheduledTime).getUTCHours();
      if (H === 10 || H === 18) ctx.waitUntil(dispararRobot(env, `0 ${H} * * *`));
      ctx.waitUntil(syncFlota(env).catch(e => console.log('Flota:', e && e.message)));
    } else ctx.waitUntil(dispararRobot(env, event.cron));
  },
};
