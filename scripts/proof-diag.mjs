// Diagnóstico read-only do projeto de prova (manifesto + jobs).
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
const p = await (await fetch(`${SB}/rest/v1/video_projects?id=eq.${pid}&select=manifest,metadata,user_id`, { headers: h })).json();
const manifest = p[0]?.manifest;
console.log('STEPS', JSON.stringify(manifest?.steps));
console.log('BRIEF_PRESENT', typeof manifest?.brief === 'string', (manifest?.brief || '').slice(0, 120));
const jobs = await (await fetch(`${SB}/rest/v1/video_v4_jobs?project_id=eq.${pid}&select=step,status,credits_cost,result,created_at&order=created_at.asc`, { headers: h })).json();
console.log('JOBS', JSON.stringify(jobs).slice(0, 1500));
const cr = await (await fetch(`${SB}/rest/v1/user_credits?user_id=eq.${p[0]?.user_id}&select=total_credits_balance`, { headers: h })).json();
console.log('CREDITS', JSON.stringify(cr));