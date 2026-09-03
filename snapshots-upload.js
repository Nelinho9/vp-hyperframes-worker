/**
 * snapshots-upload — V5-P6A (§11): publica os snapshots do render final para
 * o quality gate. O CLI `hyperframes snapshot --frames 5` escreve PNGs em
 * `{jobDir}/snapshots/` que até aqui ficavam LOCAIS ao worker; este módulo
 * copia-os (renomeados, determinísticos) para
 *   projects/{id}/snapshots/frame-N.png   (upsert — re-render sobrepõe)
 *
 * A edge video-v4-quality lista este prefixo e analisa ≤5 frames. Falha é
 * NUNCA fatal para o render: log + 0, e o gate responde NO_SNAPSHOTS
 * (retryable) em vez de bloquear nada.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ARTIFACTS_BUCKET = "video-artifacts";

/** Orchestrator project ids are UUIDs; internal/test ids are skipped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_RENDER_SNAPSHOTS = 5;

/** Storage path determinístico do N-ésimo snapshot do render final. */
export function snapshotStoragePath(projectId, n) {
  return `projects/${projectId}/snapshots/frame-${n}.png`;
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
    log(`[snapshots-upload] no snapshot pngs found for ${projectId}`);
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
