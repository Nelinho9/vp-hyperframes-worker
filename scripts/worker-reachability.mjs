// Sonda de reachability do worker (pré-requisito das provas de paridade):
// URL configurada no .env + /health + /metrics (auth). Nunca imprime secrets.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = (env.VIDEO_V4_WORKER_URL || 'https://vp-hf.46-224-139-143.sslip.io').replace(/\/+$/, '');
console.log('WORKER_URL', url);
try {
  const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
  console.log('HEALTH', h.status, (await h.text()).slice(0, 200));
} catch (err) {
  console.log('HEALTH_UNREACHABLE', String(err?.message ?? err).slice(0, 200));
}
try {
  const m = await fetch(`${url}/metrics`, { headers: { 'x-worker-secret': env.VIDEO_V4_WORKER_SECRET || '' }, signal: AbortSignal.timeout(15_000) });
  console.log('METRICS', m.status, (await m.text()).slice(0, 400));
} catch (err) {
  console.log('METRICS_UNREACHABLE', String(err?.message ?? err).slice(0, 200));
}