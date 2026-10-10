/**
 * render-evidence.js — F04-T08/T09 worker (V5.34).
 *
 * Index/manifest por job/revision (source, render job, composition hash,
 * CLI version, timestamp, scene/boundary IDs, paths/hashes/status).
 * Publicação atómica; parcial declara missing sem promover set antigo.
 * Schedule determinístico de TODAS as root scene windows + boundaries/transições + CTA.
 */

export const CLI_VERSION = "0.7.109";
export const MANIFEST_VERSION = 1;

/** "complete" só com outputs + sem missing; senão "partial" (nunca promove set antigo). */
export function evidenceStatus(manifest) {
  if (!manifest || !Array.isArray(manifest.outputs) || manifest.outputs.length === 0) return "partial";
  if (Array.isArray(manifest.coverage?.missing) && manifest.coverage.missing.length > 0) return "partial";
  return "complete";
}

/** Namespace job/revision para snapshots (troca paths globais frame-N). */
export function evidenceSnapshotPath({ projectId, jobId, revision, file }) {
  const safe = String(file ?? "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "frame.png";
  return `projects/${projectId}/evidence/${jobId}-r${revision}/${safe}`;
}

/**
 * Schedule determinístico: todas root windows + boundary + CTA final.
 * Cenas curtas com clamping frame-exato; nested tratados pelo chamador (só root entra).
 * Orçamento documentado via maxSamples; excedente vira skipped explícito.
 */
export function buildCoverageSchedule({ windows, fps = 30, maxSamples = 24 }) {
  const frame = 1 / Math.max(1, fps);
  const samples = [];
  const skipped = [];
  const missing = [];
  const sorted = [...(windows ?? [])].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return { samples, skipped, missing: ["no-root-windows"] };
  for (const w of sorted) {
    const dur = w.end - w.start;
    if (!(dur > 0)) { skipped.push({ id: w.id, reason: "duração inválida" }); continue; }
    const clamp = (t) => Math.min(Math.max(t, w.start), w.end - Math.min(0.05, frame));
    const mid = w.start + dur / 2;
    const post = Math.min(w.start + 1.5, mid, w.end - 0.05);
    samples.push({ scene_id: w.id, time_s: Math.round(clamp(post) * 1000) / 1000, kind: "post-entrance" });
    const boundary = clamp(w.start + Math.max(frame * 2, 0.1));
    if (boundary < w.end) samples.push({ scene_id: w.id, time_s: Math.round(boundary * 1000) / 1000, kind: "boundary" });
  }
  const last = sorted[sorted.length - 1];
  if (last) {
    const t = Math.min(Math.max(last.end - 0.05, last.start), last.end - Math.min(0.05, frame));
    samples.push({ scene_id: last.id, time_s: Math.round(t * 1000) / 1000, kind: "final-cta" });
  }
  samples.sort((a, b) => a.time_s - b.time_s);
  if (samples.length > maxSamples) {
    const dropped = samples.splice(maxSamples);
    for (const d of dropped) skipped.push({ id: d.scene_id, reason: `orçamento maxSamples=${maxSamples} (tempo/tamanho)` });
  }
  return { samples, skipped, missing };
}

/**
 * Monta manifest V1 (puro; I/O fica no server/snapshots-upload).
 */
export function buildEvidenceManifest({
  jobId, projectId, step, revision, inputHash,
  compositionHash, effectiveConfigRevision, effectiveConfigHash,
  sceneIds, boundaryIds, outputs, snapshots, coverage, generatedAt,
}) {
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    job_id: jobId,
    project_id: projectId,
    step,
    revision,
    input_hash: inputHash ?? "",
    composition_hash: compositionHash ?? "",
    effective_config_revision: effectiveConfigRevision ?? 0,
    effective_config_hash: effectiveConfigHash ?? "",
    cli_version: CLI_VERSION,
    generated_at: generatedAt ?? new Date().toISOString(),
    scene_ids: sceneIds ?? [],
    boundary_ids: boundaryIds ?? [],
    outputs: outputs ?? [],
    snapshots: snapshots ?? [],
    coverage: coverage ?? { total_windows: 0, sampled: 0, skipped: [], missing: [] },
    status: "partial",
  };
  manifest.status = evidenceStatus(manifest);
  return manifest;
}
