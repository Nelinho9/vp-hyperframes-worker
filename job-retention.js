/**
 * job-retention.js — F3 (plano Video-Engine v2, emenda H1): retenção/TTL dos
 * job dirs do worker. Com o volume persistente, os artefactos acumulados
 * enchem o disco do VPS; a cópia durável crítica vive na Supabase Storage
 * (composição, registry, renders, evidence) — o volume é cache reconstruível.
 *
 * Regras:
 * - Só poda jobs TERMINAIS (done/failed) mais antigos que o TTL.
 * - Nunca toca queued/running (trabalho vivo) nem dirs não-UUID (font cache).
 * - Estado ilegível → mantém (fail-safe; nunca apaga o que não consegue ler).
 * - TTL 0 desliga a poda (JOB_RETENTION_TTL_DAYS=0).
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UUID_RE, confinedPath } from './job-contract.js';

export const DEFAULT_RETENTION_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export function retentionTtlMs(env = process.env) {
  const raw = Number(env.JOB_RETENTION_TTL_DAYS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETENTION_TTL_DAYS * DAY_MS;
  return raw * DAY_MS;
}

/**
 * Poda job dirs terminais expirados. `jobs`/`projectJobs` são os mapas vivos
 * do server (atualizados in-place); jobs sem registo em memória são decididos
 * pelo job-state-v1.json durável. Devolve { pruned, kept, errors }.
 */
export function pruneTerminalJobs({ root, jobs, projectJobs, ttlMs, now = Date.now, log = () => {} }) {
  const result = { pruned: 0, kept: 0, errors: 0 };
  if (!(ttlMs > 0)) return result;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const job = jobs.get(entry.name);
    let status = job?.status;
    let completedAt = job?.completed_at;
    if (!job) {
      try {
        const state = JSON.parse(readFileSync(join(root, entry.name, 'job-state-v1.json'), 'utf8'));
        status = state.status;
        completedAt = state.completed_at;
      } catch {
        result.kept += 1; // ilegível → fail-safe, mantém
        continue;
      }
    }
    if (status !== 'done' && status !== 'failed') { result.kept += 1; continue; }
    const ts = Date.parse(completedAt ?? '');
    if (!Number.isFinite(ts) || now() - ts < ttlMs) { result.kept += 1; continue; }
    try {
      rmSync(confinedPath(root, entry.name), { recursive: true, force: true });
      jobs.delete(entry.name);
      for (const [projectId, jobId] of projectJobs) {
        if (jobId === entry.name) projectJobs.delete(projectId);
      }
      result.pruned += 1;
      log(`[retention] pruned terminal job ${entry.name} (${status})`);
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

/**
 * Uso de disco do WORK_DIR (bytes) para /metrics — best-effort com teto de
 * entradas para nunca bloquear o event loop num volume muito cheio.
 */
export function directoryBytes(root, maxEntries = 20_000) {
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < maxEntries) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (seen >= maxEntries) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += statSync(full).size; } catch { /* best-effort */ }
      }
    }
  }
  return total;
}