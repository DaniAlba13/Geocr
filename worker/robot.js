// Disparo puntual del robot NAX desde Cloudflare (cron del Worker), porque el horario de GitHub llega con horas de atraso.
//  · 10:00 UTC (6:00 a. m. RD) y 18:00 UTC (2:00 p. m. RD): lanzan el workflow nax-diario.yml.
//  · 11:30 UTC y 19:30 UTC: respaldo; si desde la hora de su turno no hubo corrida exitosa o en curso, lo lanzan otra vez.
// Necesita el secret GH_DISPATCH_TOKEN en Cloudflare: token de GitHub de grano fino, solo para el repositorio
// DaniAlba13/Geocr, con permiso "Actions: Read and write". Nunca se escribe en el código.
const REPO = 'DaniAlba13/Geocr', WF = 'nax-diario.yml';
const gh = (env, path, init = {}) => fetch('https://api.github.com/repos/' + REPO + path, {
  ...init,
  headers: { authorization: 'Bearer ' + env.GH_DISPATCH_TOKEN, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'agroap-cr-robot', ...(init.body ? { 'content-type': 'application/json' } : {}) },
});

// ¿Ya hubo corrida (exitosa o en curso) desde el inicio del turno? horaUTC: 10 (6 a. m. RD) o 18 (2 p. m. RD).
async function yaCorrioEnTurno(env, horaUTC) {
  const desde = new Date().toISOString().slice(0, 10) + 'T' + String(horaUTC).padStart(2, '0') + ':00:00Z';
  const r = await gh(env, `/actions/workflows/${WF}/runs?per_page=20&created=>=${desde}`);
  if (!r.ok) return false;
  const j = await r.json();
  return (j.workflow_runs || []).some(x => x.conclusion === 'success' || x.status === 'in_progress' || x.status === 'queued');
}

export async function dispararRobot(env, cron) {
  if (!env.GH_DISPATCH_TOKEN) { console.log('Robot NAX: falta el secret GH_DISPATCH_TOKEN; no se dispara.'); return { ok: false, motivo: 'sin token' }; }
  const respaldo = cron && cron.startsWith('30 ');
  const turno = cron && / (1[89]|2\d) /.test(' ' + cron.split(' ')[1] + ' ') ? 18 : 10;
  if (respaldo && await yaCorrioEnTurno(env, turno)) { console.log(`Robot NAX: el turno de las ${turno - 4}:00 RD ya corrió; el respaldo no hace nada.`); return { ok: true, motivo: 'ya corrió' }; }
  const r = await gh(env, `/actions/workflows/${WF}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  const ok = r.status === 204;
  console.log(`Robot NAX (${respaldo ? 'respaldo' : 'principal'}): GitHub respondió ${r.status}${ok ? '' : ' ' + (await r.text()).slice(0, 200)}`);
  return { ok, status: r.status };
}
