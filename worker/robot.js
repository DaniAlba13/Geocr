// Disparo puntual del robot NAX desde Cloudflare (cron del Worker), porque el horario de GitHub llega con horas de atraso.
//  · 10:00 UTC (6:00 a. m. RD): lanza el workflow nax-diario.yml.
//  · 11:30 UTC (7:30 a. m. RD): revisa si hoy ya hubo una corrida exitosa o en curso; si no, lo lanza otra vez.
// Necesita el secret GH_DISPATCH_TOKEN en Cloudflare: token de GitHub de grano fino, solo para el repositorio
// DaniAlba13/Geocr, con permiso "Actions: Read and write". Nunca se escribe en el código.
const REPO = 'DaniAlba13/Geocr', WF = 'nax-diario.yml';
const gh = (env, path, init = {}) => fetch('https://api.github.com/repos/' + REPO + path, {
  ...init,
  headers: { authorization: 'Bearer ' + env.GH_DISPATCH_TOKEN, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'agroap-cr-robot', ...(init.body ? { 'content-type': 'application/json' } : {}) },
});

async function yaCorrioHoy(env) {
  const hoy = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);   // fecha en RD (UTC−4)
  const r = await gh(env, `/actions/workflows/${WF}/runs?per_page=20&created=>=${hoy}T04:00:00Z`);
  if (!r.ok) return false;
  const j = await r.json();
  return (j.workflow_runs || []).some(x => x.conclusion === 'success' || x.status === 'in_progress' || x.status === 'queued');
}

export async function dispararRobot(env, cron) {
  if (!env.GH_DISPATCH_TOKEN) { console.log('Robot NAX: falta el secret GH_DISPATCH_TOKEN; no se dispara.'); return { ok: false, motivo: 'sin token' }; }
  const respaldo = cron && cron.startsWith('30 ');
  if (respaldo && await yaCorrioHoy(env)) { console.log('Robot NAX: ya hay corrida de hoy; el respaldo no hace nada.'); return { ok: true, motivo: 'ya corrió' }; }
  const r = await gh(env, `/actions/workflows/${WF}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  const ok = r.status === 204;
  console.log(`Robot NAX (${respaldo ? 'respaldo' : 'principal'}): GitHub respondió ${r.status}${ok ? '' : ' ' + (await r.text()).slice(0, 200)}`);
  return { ok, status: r.status };
}
