// Diagnóstico read-only alargado: manifesto atual + todos os jobs + effective_config.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const pids = process.argv.slice(2);
for (const pid of pids) {
  const p = await (await fetch(`${SB}/rest/v1/video_projects?id=eq.${pid}&select=manifest,metadata`, { headers: h })).json();
  const manifest = p[0]?.manifest;
  console.log(`\n=== ${pid} ===`);
  console.log('EFFECTIVE_CONFIG', JSON.stringify(p[0]?.metadata?.effective_config ?? null));
  for (const [s, v] of Object.entries(manifest?.steps ?? {})) {
    console.log(`STEP ${s}: ${v.status} artifacts=${JSON.stringify(v.artifacts)} credits=${v.credits ?? '-'} err=${String(v.error ?? '').slice(0, 160)}`);
  }
  console.log('CREDITS', JSON.stringify(manifest?.credits));
  const jobs = await (await fetch(`${SB}/rest/v1/video_v4_jobs?project_id=eq.${pid}&select=id,step,status,credits_cost,credits_refunded,created_at,dispatched_at&order=created_at.asc`, { headers: h })).json();
  for (const j of jobs) console.log(`JOB ${j.step} ${j.status} cost=${j.credits_cost} refunded=${j.credits_refunded} created=${j.created_at} dispatched=${j.dispatched_at ?? '-'} id=${j.id}`);
}