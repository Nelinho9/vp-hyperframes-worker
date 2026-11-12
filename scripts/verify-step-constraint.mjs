// Verifica a definição real do CHECK constraint video_v4_jobs_step_check no
// projeto remoto via Management API oficial. Token do env/CLI, nunca exibido.
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
const sql = `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.video_v4_jobs'::regclass AND contype = 'c' ORDER BY conname;`;
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
console.log('HTTP', res.status);
console.log((await res.text()).slice(0, 2000));