/**
 * composition-publication — F05 (V5.34 C5): publicação coerente HTML/registry.
 *
 * O HTML continua canónico; o registry é vista derivada versionada. A
 * publicação F05 exige:
 *   1. HTML e registry referem a MESMA revisão (sem revisão → escrita legacy
 *      bloqueada, nunca default silencioso).
 *   2. Falha de publicação tem estado RECUPERÁVEL (partial explícito), nunca
 *      lista vazia de sucesso.
 *   3. Revisão stale (expected !== current) recusa com 409 sem sobrescrever a
 *      composição mais recente (F05 não depende da futura fila da F06).
 */

export const LEGACY_WRITE_BLOCKED = "LEGACY_WRITE_BLOCKED";
export const REVISION_CONFLICT = "REVISION_CONFLICT";

/**
 * Valida uma escrita com revisão esperada contra a revisão corrente.
 * Legacy sem revisão é bloqueado (não há default silencioso).
 */
export function validateRevisionForWrite({ expectedRevision, currentRevision }) {
  const expected = expectedRevision === null || expectedRevision === undefined ? null : expectedRevision;
  const current = currentRevision === null || currentRevision === undefined ? null : currentRevision;
  if (expected === null || !Number.isInteger(expected) || expected < 0) {
    return { ok: false, code: LEGACY_WRITE_BLOCKED, message: "escrita sem revision explícita bloqueada (legacy sem revisão não sobrescreve documento novo)" };
  }
  if (current !== null && Number.isInteger(current) && expected !== current) {
    return { ok: false, code: REVISION_CONFLICT, message: `revisão stale: esperada ${expected}, corrente ${current}` };
  }
  return { ok: true, code: "OK" };
}

/**
 * Constrói uma publicação coerente HTML + registry para a mesma revisão.
 * Lança em revision ausente/inválida ou registry incoerente.
 */
export function buildCoherentPublication({ html, registry, revision, compositionId }) {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("buildCoherentPublication: html vazio");
  }
  if (!registry || !Array.isArray(registry.elements)) {
    throw new Error("buildCoherentPublication: registry inválido");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw Object.assign(new Error("buildCoherentPublication: revision explícita obrigatória"), { code: LEGACY_WRITE_BLOCKED });
  }
  const regRevision = registry.revision ?? null;
  if (regRevision !== null && regRevision !== revision) {
    throw Object.assign(
      new Error(`buildCoherentPublication: registry revision ${regRevision} ≠ html revision ${revision}`),
      { code: REVISION_CONFLICT },
    );
  }
  const coherent = {
    ...registry,
    revision,
    compositionId: registry.compositionId || compositionId || "main",
  };
  coherent.elements = coherent.elements.map((e) => ({ ...e, revision }));
  return { html, registry: coherent, revision, compositionId: coherent.compositionId };
}

/**
 * Converte dois ACKs de upload (html + registry) num resultado nunca vazio.
 * Falha total → { persisted:false, status:"failed", recoverable:true }.
 * HTML ok + registry em falha → partial explícito (registry pode ser
 * re-derivado do HTML canónico; nunca se promove set antigo como atual).
 */
export function toPersistResult({ htmlOk, registryOk }) {
  if (htmlOk && registryOk) {
    return { persisted: true, persisted_elements: true, status: "complete", recoverable: true };
  }
  if (htmlOk && !registryOk) {
    return { persisted: true, persisted_elements: false, status: "partial-registry-missing", recoverable: true };
  }
  return { persisted: false, persisted_elements: false, status: "failed", recoverable: true };
}
