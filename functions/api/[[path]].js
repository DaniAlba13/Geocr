// Compatibilidad con Cloudflare Pages: la lógica vive en worker/api.js.
export { onRequest } from '../../worker/api.js';
