// F0.2 (plano v2): verificar/criar volume persistente do worker no Coolify.
// Lê COOLIFY_URL/COOLIFY_API_KEY do .env do visttapro (nunca imprime secrets).
// Resolve o app uuid pelo FQDN (o uuid não é estável entre ambientes).
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const base = (env.COOLIFY_URL || '').replace(/\/+$/, '').replace(/\/login$/, '');
const key = env.COOLIFY_API_KEY || '';
if (!base || !key) { console.log('COOLIFY_CONFIG_MISSING'); process.exit(0); }
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };

async function api(path, opts = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, body, text: text.slice(0, 300) };
}

const apps = await api('/applications');
if (apps.status !== 200) { console.log('APPS_LIST_FAILED', apps.status, apps.text); process.exit(0); }
const list = Array.isArray(apps.body) ? apps.body : [];
const worker = list.find((a) => String(a.fqdn || '').includes('vp-hf.')) || list.find((a) => /hyperframes|worker/i.test(a.name || ''));
if (!worker) { console.log('WORKER_APP_NOT_FOUND', list.map((a) => a.name).join(', ')); process.exit(0); }
console.log('WORKER_APP', JSON.stringify({ uuid: worker.uuid, name: worker.name, fqdn: worker.fqdn, status: worker.status }));

// Tentar o endpoint de storages (versões recentes do Coolify expõem-no).
const storages = await api(`/applications/${worker.uuid}/storages`);
console.log('STORAGES_ENDPOINT', storages.status, storages.status === 200 ? JSON.stringify(storages.body) : storages.text);
if (storages.status === 404 || storages.status === 405) {
  console.log('VERDICT: API sem endpoint de storages — volume requer ação manual no UI (Storages tab): vp-worker-data -> /tmp/hyperframes-worker');
  process.exit(0);
}
if (storages.status === 200) {
  // Shape real: { persistent_storages: [...], file_storages: [...] }.
  const persistent = Array.isArray(storages.body?.persistent_storages)
    ? storages.body.persistent_storages
    : (Array.isArray(storages.body) ? storages.body : []);
  const existing = persistent.find((s) => s.mount_path === '/tmp/hyperframes-worker' || String(s.name || '').includes('vp-worker-data'));
  if (existing) { console.log('VOLUME_ALREADY_PRESENT', JSON.stringify({ name: existing.name, mount_path: existing.mount_path, created_at: existing.created_at })); process.exit(0); }
  const created = await api(`/applications/${worker.uuid}/storages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'persistent', name: 'vp-worker-data', mount_path: '/tmp/hyperframes-worker', is_directory: true }),
  });
  console.log('VOLUME_CREATE', created.status, created.text);
}