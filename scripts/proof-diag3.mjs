// Quem executou o quê: step states completos + transações de crédito do período.
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
const p = await (await fetch(`${SB}/rest/v1/video_projects?id=eq.${pid}&select=manifest,user_id`, { headers: h })).json();
const manifest = p[0]?.manifest;
for (const s of ['design', 'storyboard', 'audio', 'visual']) {
  console.log(`STEP ${s}`, JSON.stringify(manifest?.steps?.[s]));
}
const uid = p[0]?.user_id;
const tx = await (await fetch(`${SB}/rest/v1/credit_transactions?user_id=eq.${uid}&created_at=gte.2026-11-12T18:40:00Z&created_at=lte.2026-11-12T19:10:00Z&select=transaction_type,amount,reference_id,description,created_at&order=created_at.asc`, { headers: h })).json();
for (const t of tx) console.log(`TX ${t.created_at} ${t.transaction_type} ${t.amount} ref=${t.reference_id} ${String(t.description).slice(0, 60)}`);