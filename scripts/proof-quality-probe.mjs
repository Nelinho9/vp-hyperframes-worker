// Diagnóstico read-only + retoma controlada do quality gate (endpoint real do .env).
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const ORCH = `${SB}/functions/v1/video-v4-orchestrator`;
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const pid = process.argv[2];
const st = await (await fetch(`${ORCH}/status?project_id=${pid}`, { headers: h })).json();
console.log('STATUS action=', st?.action, 'idle=', st?.idle, 'quality=', st?.manifest?.steps?.quality?.status);
const doResume = process.argv[3] === 'resume';
if (doResume) {
  const r = await fetch(`${ORCH}/resume`, { method: 'POST', headers: h, body: JSON.stringify({ project_id: pid }) });
  console.log('RESUME', r.status, JSON.stringify(await r.json().catch(() => null)).slice(0, 400));
}