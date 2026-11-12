// Lista utilizadores com créditos (read-only) para escolher a conta das
// provas de paridade. Nunca imprime keys/tokens.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const res = await fetch(`${SB}/rest/v1/user_credits?select=user_id,total_credits_balance,updated_at&order=total_credits_balance.desc&limit=10`, { headers });
const rows = await res.json();
console.log('CREDIT_ROWS', JSON.stringify(rows));
for (const r of (Array.isArray(rows) ? rows : []).slice(0, 5)) {
  const u = await fetch(`${SB}/auth/v1/admin/users/${r.user_id}`, { headers });
  const user = await u.json().catch(() => null);
  console.log('USER', JSON.stringify({ id: r.user_id, email: user?.email, balance: r.total_credits_balance, created: user?.created_at }));
}