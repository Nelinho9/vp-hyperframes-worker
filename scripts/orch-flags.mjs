// Consulta os secrets do projeto via Management API oficial e imprime APENAS
// os feature flags V4_BUILD_ON_WORKER / V4_LLM_STEPS_ON_WORKER (não sensíveis).
// NUNCA imprime keys/tokens/passwords. Token lido do env/CLI, nunca exibido.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const candidates = [
  join(homedir(), '.supabase', 'access-token'),
  join(homedir(), 'AppData', 'Roaming', 'supabase', 'access-token'),
  join(homedir(), '.config', 'supabase', 'access-token'),
];
let token = process.env.SUPABASE_ACCESS_TOKEN || '';
if (!token) for (const p of candidates) if (existsSync(p)) { token = readFileSync(p, 'utf8').trim(); break; }
if (!token) { console.log('NO_TOKEN'); process.exit(0); }
const REF = 'syyxuhrvyfxagcadrlqb';
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/secrets`, { headers: { Authorization: `Bearer ${token}` } });
console.log('HTTP', res.status);
const arr = await res.json().catch(() => []);
const allow = new Set(['V4_BUILD_ON_WORKER', 'V4_LLM_STEPS_ON_WORKER', 'V4_2_STEPS']);
if (Array.isArray(arr)) {
  for (const s of arr) if (allow.has(s.name)) console.log('FLAG', s.name, '=', s.value);
  console.log('TOTAL_SECRETS', arr.length, '(values hidden except allowlisted flags)');
} else { console.log(JSON.stringify(arr).slice(0, 300)); }