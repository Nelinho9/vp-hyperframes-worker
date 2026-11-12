// Consulta/aplica SQL no projeto via Management API oficial (api.supabase.com).
// Token do env/CLI, nunca exibido. Uso: node db-query.mjs "<SQL>"
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
const sql = process.argv[2];
if (!sql) { console.log('NO_SQL'); process.exit(0); }
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
console.log('HTTP', res.status);
const body = await res.text();
console.log(body.slice(0, 2000));