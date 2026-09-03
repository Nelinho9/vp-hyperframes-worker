/**
 * composition-persist — persiste a composição staged no Supabase Storage.
 *
 * V4_04 follow-up: no fluxo orquestrador→worker, o HTML da composição vivia
 * apenas no disco local do worker (job_dir) e era servido por /preview/:id —
 * nunca chegava a `projects/{id}/compositions/index.html` no storage. O
 * editor (V4-04B) trata esse objeto como fonte primária pós-build para
 * reconciliar durações da timeline e como alvo das edições (V4-04C), pelo
 * que cada download resultava num 400 garantido ("Object not found") e a
 * timeline caía nas durações do STORYBOARD.md em vez das reais.
 *
 * Este módulo faz o upsert fire-and-forget no staging (POST /job); o resultado
 * é reportado ao orquestrador via `callback.uploaded.composition_html`, que o
 * registra nos artifacts do build — o frontend só descarrega quando o
 * manifesto prova que o objeto existe.
 */

const ARTIFACTS_BUCKET = "video-artifacts";

/** Orchestrator project ids are UUIDs; internal/test ids are skipped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage path of the persisted composition for a project. */
export function compositionStoragePath(projectId) {
  return `projects/${projectId}/compositions/index.html`;
}

/**
 * Upsert the staged composition HTML into storage.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient | null} supabase
 * @param {string} projectId
 * @param {string} html
 * @param {(msg: string) => void} [log]
 * @param {(message: string) => void} [onFailure]
 * @returns {Promise<boolean>} true quando o upload foi confirmado.
 */
export async function persistCompositionArtifact(supabase, projectId, html, log = () => {}, onFailure = () => {}) {
  if (!supabase) return false;
  if (!projectId || !UUID_RE.test(projectId)) {
    log(`[composition-persist] skip non-orchestrator project id (${projectId})`);
    return false;
  }
  if (typeof html !== "string" || html.length === 0) {
    log("[composition-persist] skip empty html");
    return false;
  }
  try {
    const { error } = await supabase.storage
      .from(ARTIFACTS_BUCKET)
      .upload(compositionStoragePath(projectId), html, {
        contentType: "text/html",
        upsert: true,
      });
    if (error) {
      log(`[composition-persist] upload failed for ${projectId}: ${error.message}`);
      onFailure(error.message);
      return false;
    }
    log(`[composition-persist] persisted compositions/index.html for ${projectId}`);
    return true;
  } catch (err) {
    const message = err?.message ?? String(err);
    log(`[composition-persist] unexpected failure for ${projectId}: ${message}`);
    onFailure(message);
    return false;
  }
}
