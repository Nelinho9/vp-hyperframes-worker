// F1/F2/F3 (plano v2): deploy do worker no Coolify (autorizado pelo operador).
// Lê COOLIFY_URL/COOLIFY_API_KEY do .env do visttapro (nunca imprime secrets).
// Resolve o app uuid pelo FQDN, dispara o deploy, faz poll até terminal e
// verifica /health no FQDN público. Atestação: o commit local tem de estar
// pushed (o Coolify puxa o branch remoto).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();

const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const base = (env.COOLIFY_URL || '').replace(/\/+$/, '').replace(/\/login$/, '');
const key = env.COOLIFY_API_KEY || '';
if (!base || !key) { console.log('COOLIFY_CONFIG_MISSING'); process.exit(1); }
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };

async function api(path, opts = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, body, text: text.slice(0, 400) };
}

const localHead = git(['rev-parse', 'HEAD']);
const remoteHead = git(['rev-parse', 'origin/main']);
console.log('LOCAL_HEAD', localHead);
console.log('REMOTE_HEAD', remoteHead);
if (localHead !== remoteHead) { console.log('PUSH_REQUIRED: local HEAD não está em origin/main'); process.exit(1); }

const apps = await api('/applications');
if (apps.status !== 200) { console.log('APPS_LIST_FAILED', apps.status, apps.text); process.exit(1); }
const list = Array.isArray(apps.body) ? apps.body : [];
const worker = list.find((a) => String(a.fqdn || '').includes('vp-hf.')) || list.find((a) => /hyperframes|worker/i.test(a.name || ''));
if (!worker) { console.log('WORKER_APP_NOT_FOUND'); process.exit(1); }
console.log('WORKER_APP', JSON.stringify({ uuid: worker.uuid, name: worker.name, fqdn: worker.fqdn, status: worker.status }));

const deploy = await api(`/deploy?uuid=${worker.uuid}`, { method: 'POST' });
console.log('DEPLOY_TRIGGER', deploy.status, deploy.text);
if (deploy.status !== 200 && deploy.status !== 201) { console.log('DEPLOY_TRIGGER_FAILED'); process.exit(1); }
const deploymentUuid = deploy.body?.deployments?.[0]?.deployment_uuid || deploy.body?.deployment_uuid;
if (!deploymentUuid) { console.log('DEPLOYMENT_UUID_MISSING'); process.exit(1); }

const deadline = Date.now() + 12 * 60 * 1000;
let final = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000));
  const st = await api(`/deployments/${deploymentUuid}`);
  const status = st.body?.status || 'unknown';
  console.log('DEPLOY_STATUS', status);
  if (['finished', 'failed', 'cancelled', 'error'].includes(status)) { final = st.body; break; }
}
if (!final) { console.log('DEPLOY_POLL_TIMEOUT'); process.exit(1); }
console.log('DEPLOY_FINAL', JSON.stringify({
  status: final.status,
  commit: final.commit || null,
  branch: final.branch || null,
  finished_at: final.finished_at || null,
}));
if (final.status !== 'finished') { console.log('DEPLOY_NOT_FINISHED'); process.exit(1); }

// Atestação de saúde no FQDN público (pode falhar por ingress — reportar honesto).
const fqdn = String(worker.fqdn || '').split(',')[0].trim();
try {
  const health = await fetch(`${fqdn}/health`, { signal: AbortSignal.timeout(20_000) });
  const body = await health.text();
  console.log('PUBLIC_HEALTH', health.status, body.slice(0, 300));
} catch (err) {
  console.log('PUBLIC_HEALTH_UNREACHABLE', String(err?.message ?? err).slice(0, 200));
}
console.log('DEPLOY_OK commit_local=' + localHead);