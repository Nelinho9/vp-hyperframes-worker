// Lê o access token do CLI Supabase (ficheiro de config local) e consulta os
// logs da edge video-v4-orchestrator via Management API oficial (api.supabase.com).
// NUNCA imprime o token. Filtra linhas relevantes para o quality gate.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const candidates = [
  join(homedir(), '.supabase', 'access-token'),
  join(homedir(), 'AppData', 'Roaming', 'supabase', 'access-token'),
  join(homedir(), '.config', 'supabase', 'access-token'),
];
let token = process.env.SUPABASE_ACCESS_TOKEN || '';
let src = 'env';
if (!token) {
  for (const p of candidates) {
    if (existsSync(p)) { token = readFileSync(p, 'utf8').trim(); src = p; break; }
  }
}
if (!token) { console.log('NO_TOKEN_FOUND candidates=', candidates.join(' | ')); process.exit(0); }
console.log('TOKEN_SOURCE', src, 'len', token.length);

const REF = 'syyxuhrvyfxagcadrlqb';
const pid = process.argv[2] || '';
// Management API oficial: endpoint `logs` (logs.all removido, HTTP 410).
const sql = `select timestamp, event_message from logs where source = 'edge_logs' order by timestamp desc limit 100`;
const url = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
console.log('HTTP', res.status);
const body = await res.text();
if (!res.ok) { console.log(body.slice(0, 500)); process.exit(0); }
let data; try { data = JSON.parse(body); } catch { console.log(body.slice(0, 500)); process.exit(0); }
const rows = data?.result || data?.rows || data || [];
const arr = Array.isArray(rows) ? rows : [];
if (arr.length === 0) { console.log('RAW_KEYS', Object.keys(data || {})); console.log('RAW_SAMPLE', body.slice(0, 800)); }
let shown = 0;
for (const r of arr) {
  const msg = String(r.event_message ?? r.message ?? JSON.stringify(r));
  if (pid && !msg.includes(pid) && !/quality|background pipeline failed|LLM_STEP|WORKER_AUTH/i.test(msg)) continue;
  if (!/quality|background pipeline failed|LLM_STEP|WORKER_AUTH|f5077f0e/i.test(msg)) continue;
  console.log((r.timestamp ?? '').slice(0, 19), msg.slice(0, 400));
  if (++shown > 40) break;
}
console.log('SHOWN', shown, 'of', arr.length);