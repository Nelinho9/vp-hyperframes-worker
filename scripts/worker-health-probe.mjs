// Diagnóstico read-only: host do Coolify vs worker; retry do /health.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
try {
  const u = new URL(env.COOLIFY_URL || '');
  console.log('COOLIFY_HOST', u.hostname, u.port || (u.protocol === 'https:' ? '443' : '80'), u.protocol);
} catch { console.log('COOLIFY_URL_INVALID'); }
for (const url of ['https://vp-hf.46-224-139-143.sslip.io/health', 'http://46.224.139.143:8787/health']) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    console.log('PROBE', url, res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.log('PROBE_FAIL', url, err?.cause?.code || err?.message);
  }
}