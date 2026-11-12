// Lista o diretório evidence/ e snapshots/ do projeto no Storage oficial
// (URL/keys do .env) e tenta ler o evidence-manifest. Confirma o que o quality
// gate consegue descobrir. Nunca imprime keys/URLs assinadas.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const pid = process.argv[2];
async function list(prefix) {
  const r = await fetch(`${SB}/storage/v1/object/list/video-artifacts`, { method: 'POST', headers: h, body: JSON.stringify({ prefix, limit: 100 }) });
  return await r.json().catch(() => null);
}
const ev = await list(`projects/${pid}/evidence`);
console.log('EVIDENCE_DIR', JSON.stringify((ev || []).map((f) => f.name)));
for (const sub of (ev || []).filter((f) => !f.name.includes('.'))) {
  const inner = await list(`projects/${pid}/evidence/${sub.name}`);
  const names = (inner || []).map((f) => f.name);
  console.log('SUB', sub.name, JSON.stringify(names));
  if (names.includes('evidence-manifest.json')) {
    const dl = await fetch(`${SB}/storage/v1/object/video-artifacts/projects/${pid}/evidence/${sub.name}/evidence-manifest.json`, { headers: h });
    const txt = await dl.text();
    try { const j = JSON.parse(txt); console.log('MANIFEST', sub.name, JSON.stringify({ revision: j.revision, composition_revision: j.composition_revision, status: j.status, job_id: j.job_id, snapshots: (j.snapshots || []).length, project_id: j.project_id })); }
    catch { console.log('MANIFEST_PARSE_FAIL', txt.slice(0, 200)); }
  }
}