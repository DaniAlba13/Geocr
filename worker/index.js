// Worker de GeoCR: /api/* va a la API (base de datos D1); todo lo demás es la página en public/.
import { onRequest } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      try {
        return await onRequest({ request, env, params: { path } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
