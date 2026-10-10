/**
 * snapshots-upload — V5-P6A (§11) + F04-T08 (V5.34).
 *
 * Legacy (N-1): publica em projects/{id}/snapshots/frame-N.png (upsert —
 * re-render sobrepõe). Mantido para compatibilidade; a quality F04 marca-o
 * como LEGACY_UNVERIFIED quando não há evidence manifest da revisão atual.
 *
 * Novo (F04): publica em projects/{id}/evidence/{jobId}-r{revision}/{file}
 * (namespace job/revision, sem sobreposição) + manifest
 * `evidence-manifest.json` atómico (commit-marker após objetos). Parcial
 * declara missing sem promover set antigo. Não apaga snapshots históricos.
 *
 * A edge video-v4-quality lista o prefixo legacy e analisa ≤5 frames. Falha é
 * NUNCA fatal para o render: log + 0, e o gate responde NO_SNAPSHOTS
 * (retryable) em vez de bloquear nada.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ARTIFACTS_BUCKET = "video-artifacts";

/** Orchestrator project ids are UUIDs; internal/test ids are skipped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_RENDER_SNAPSHOTS = 5;

/** Storage path determinístico do N-ésimo snapshot do render final (legacy N-1). */
export function snapshotStoragePath(projectId, n) {
  return `projects/${projectId}/snapshots/frame-${n}.png`;
}

/** F04-T08: path namespaced por job/revision (sem sobreposição entre renders). */
export function evidenceSnapshotStoragePath(projectId, jobId, revision, file) {
  const safe = String(file ?? "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "frame.png";
  return `projects/${projectId}/evidence/${jobId}-r${revision}/${safe}`;
}

/** F04-T08: manifest atómico do evidence set (commit-marker após objetos). */
export function evidenceManifestStoragePath(projectId, jobId, revision) {
  return `projects/${projectId}/evidence/${jobId}-r${revision}/evidence-manifest.json`;
}

/**
 * Upload dos snapshots do job para o bucket de artifacts.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient | null} supabase
 * @param {string} projectId
 * @param {string} jobDir diretório do job (contém snapshots/*.png)
 * @param {(msg: string) => void} [log]
 * @param {(message: string) => void} [onFailure]
 * @returns {Promise<number>} número de snapshots efetivamente publicados.
 */
export async function persistRenderSnapshots(supabase, projectId, jobDir, log = () => {}, onFailure = () => {}) {
  if (!supabase) return 0;
  if (!projectId || !UUID_RE.test(projectId)) {
    log(`[snapshots-upload] skip non-orchestrator project id (${projectId})`);
    return 0;
  }
  let files = [];
  try {
    const snapDir = join(jobDir, "snapshots");
    files = readdirSync(snapDir)
      .filter((f) => f.toLowerCase().endsWith(".png"))
      // ordenação numérica estável (frame_at_10 depois do 2, não lexical)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (err) {
    const message = err?.message ?? String(err);
    log(`[snapshots-upload] snapshots dir unavailable for ${projectId}: ${message}`);
    onFailure(message);
    return 0;
  }
  if (files.length === 0) {
    const message = "no snapshot pngs found";
    log(`[snapshots-upload] ${message} for ${projectId}`);
    onFailure(message);
    return 0;
  }

  let published = 0;
  for (let i = 0; i < Math.min(files.length, MAX_RENDER_SNAPSHOTS); i++) {
    try {
      const buf = readFileSync(join(jobDir, "snapshots", files[i]));
      const { error } = await supabase.storage
        .from(ARTIFACTS_BUCKET)
        .upload(snapshotStoragePath(projectId, published + 1), buf, {
          contentType: "image/png",
          upsert: true,
        });
      if (error) {
        log(`[snapshots-upload] upload failed for ${projectId} (${files[i]}): ${error.message}`);
        onFailure(error.message);
        continue;
      }
      published++;
    } catch (err) {
      const message = err?.message ?? String(err);
      log(`[snapshots-upload] unexpected failure for ${projectId}: ${message}`);
      onFailure(message);
    }
  }
  if (published > 0) {
    log(`[snapshots-upload] persisted ${published}/${files.length} render snapshot(s) for ${projectId}`);
  }
  return published;
}

/**
 * F04-T08: publica snapshots namespaced por job/revision + manifest atómico.
 * Retorna { published, manifestPath } ou { published: 0 } em falha (nunca fatal).
 * Não promove set antigo em parcial; declara missing no manifest.
 */
export async function persistEvidenceSnapshots(supabase, { projectId, jobId, revision, jobDir, manifest, log = () => {}, onFailure = () => {} }) {
  if (!supabase) return { published: 0, manifestPath: null };
  if (!projectId || !UUID_RE.test(projectId)) {
    log(`[snapshots-upload] skip non-orchestrator project id (${projectId})`);
    return { published: 0, manifestPath: null };
  }
  let files = [];
  try {
    const snapDir = join(jobDir, "snapshots");
    files = readdirSync(snapDir).filter((f) => f.toLowerCase().endsWith(".png")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (err) {
    const message = err?.message ?? String(err);
    log(`[snapshots-upload] snapshots dir unavailable for ${projectId}: ${message}`);
    onFailure(message);
    return { published: 0, manifestPath: null };
  }
  if (files.length === 0) {
    const message = "no snapshot pngs found";
    log(`[snapshots-upload] ${message} for ${projectId}`);
    onFailure(message);
    return { published: 0, manifestPath: null };
  }
  let published = 0;
  for (const file of files.slice(0, 24)) {
    try {
      const buf = readFileSync(join(jobDir, "snapshots", file));
      const { error } = await supabase.storage.from(ARTIFACTS_BUCKET).upload(
        evidenceSnapshotStoragePath(projectId, jobId, revision, file), buf,
        { contentType: "image/png", upsert: true },
      );
      if (error) { log(`[snapshots-upload] evidence upload failed (${file}): ${error.message}`); onFailure(error.message); continue; }
      published++;
    } catch (err) {
      const message = err?.message ?? String(err);
      log(`[snapshots-upload] evidence unexpected failure: ${message}`);
      onFailure(message);
    }
  }
  // Commit-marker: manifest só após objetos.
  let manifestPath = null;
  try {
    const path = evidenceManifestStoragePath(projectId, jobId, revision);
    const { error } = await supabase.storage.from(ARTIFACTS_BUCKET).upload(
      path, Buffer.from(JSON.stringify(manifest ?? { job_id: jobId, project_id: projectId, revision, status: published > 0 ? "complete" : "partial" }), "utf-8"),
      { contentType: "application/json", upsert: true },
    );
    if (error) { log(`[snapshots-upload] evidence manifest upload failed: ${error.message}`); onFailure(error.message); }
    else { manifestPath = path; log(`[snapshots-upload] evidence manifest committed ${path} (${published} snapshots)`); }
  } catch (err) {
    const message = err?.message ?? String(err);
    log(`[snapshots-upload] evidence manifest unexpected failure: ${message}`);
    onFailure(message);
  }
  return { published, manifestPath };
}
