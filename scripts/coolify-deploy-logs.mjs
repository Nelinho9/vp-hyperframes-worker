// Diagnóstico: logs do deployment Coolify (sem secrets).
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const base = (env.COOLIFY_URL || '').replace(/\/+$/, '').replace(/\/login$/, '');
const key = env.COOLIFY_API_KEY || '';
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
const uuid = process.argv[2];
if (!uuid) { console.log('USAGE: node coolify-deploy-logs.mjs <deployment_uuid>'); process.exit(1); }

const res = await fetch(`${base}/api/v1/deployments/${uuid}`, { headers });
const body = await res.json().catch(() => null);
if (!body) { console.log('DEPLOYMENT_FETCH_FAILED', res.status); process.exit(1); }
const { logs, ...rest } = body;
console.log('DEPLOYMENT_META', JSON.stringify(rest).slice(0, 800));
if (typeof logs === 'string' && logs) {
  console.log('--- LOGS (tail 6000) ---');
  console.log(logs.slice(-6000));
} else {
  // Algumas versões expõem logs em endpoint próprio.
  const l = await fetch(`${base}/api/v1/deployments/${uuid}/logs`, { headers });
  const t = await l.text();
  console.log('LOGS_ENDPOINT', l.status, t.slice(-6000));
}