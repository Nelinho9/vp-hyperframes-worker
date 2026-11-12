// Consulta o ledger de dispatch (video_v4_job_dispatch) + jobs do projeto via
// REST oficial (URL/keys do .env). Mostra se quality chegou a ser reservado.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const pid = process.argv[2];
const jobs = await (await fetch(`${SB}/rest/v1/video_v4_jobs?project_id=eq.${pid}&select=id,step,status,credits_cost,created_at&order=created_at.asc`, { headers: h })).json();
const ids = (jobs || []).map((j) => j.id);
console.log('JOBS', (jobs || []).map((j) => `${j.step}:${j.status}`).join(' '));
const disp = await (await fetch(`${SB}/rest/v1/video_v4_job_dispatch?job_id=in.(${ids.join(',')})&select=job_id,state,charged,refunded,created_at`, { headers: h })).json();
console.log('DISPATCH_LEDGER', JSON.stringify(disp));
// Qualquer linha de dispatch com step quality (via join implícito pelos ids acima)
const q = (jobs || []).filter((j) => j.step === 'quality');
console.log('QUALITY_JOBS', q.length);