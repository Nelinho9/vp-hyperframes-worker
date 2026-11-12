// Aplica a migração fix_v4_jobs_quality_step.sql no projeto remoto via
// Management API oficial (api.supabase.com) e verifica o constraint resultante.
// Token do env/CLI, nunca exibido. DDL idempotente (DROP IF EXISTS + ADD).
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
const api = (query) => fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
const migration = readFileSync(new URL('../../visttapro/supabase/migrations/20261112210000_fix_v4_jobs_quality_step.sql', import.meta.url), 'utf8');
const apply = await api(migration);
console.log('APPLY HTTP', apply.status, (await apply.text()).slice(0, 300));
const verify = await api(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.video_v4_jobs'::regclass AND conname = 'video_v4_jobs_step_check';`);
console.log('VERIFY HTTP', verify.status, (await verify.text()).slice(0, 400));