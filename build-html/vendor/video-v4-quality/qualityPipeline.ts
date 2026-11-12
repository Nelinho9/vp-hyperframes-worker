/**
 * qualityPipeline.ts — F2 (plano Video-Engine v2): o gate de qualidade
 * pós-finalize como módulo puro com DI/env injetado. A edge `video-v4-quality`
 * e o runner `llm-step` do worker chamam EXATAMENTE este módulo — paridade
 * por construção (mesmo padrão da extração audioPipeline.ts).
 *
 * Extração behavior-preserving do index.ts (2026-11-12): o factory de visão
 * (primário + fallback), fetchWithRetry, discoverEvidenceManifestPaths,
 * extractTextBounds e o corpo do task do gate viviam no index; agora vivem
 * aqui com o env parametrizado (antes Deno.env). O caminho recheck (F10.08)
 * continua no index e reutiliza os helpers exportados.
 *
 * O gate NUNCA fabrica score em falha e NUNCA bloqueia o download — abaixo
 * de QUALITY_THRESHOLD apenas `needs_attention`.
 */
import { fetchBuffered } from '../_shared/boundedTransport.ts';
import { CompositionPublicationError } from '../_shared/compositionPublication.ts';
import { buildChatVisionRequest, readChatVisionResponse, visionEndpoint } from '../_shared/llmVision.ts';
import { assertModelIdForKind, resolveApiKey } from '../_shared/llmProvider.ts';
import { createVideoLlmFetch, hasVideoLlmFallback } from '../_shared/videoLlmTransport.ts';
import {
  MAX_SNAPSHOTS,
  QUALITY_SYSTEM_PROMPT,
  buildQualityReport,
  buildQualityUserMessage,
  pngToDataUrl,
  resolveQualitySource,
  type QualityStorage,
  type VisionClient,
} from './logic.ts';
import {
  digestManifestText,
  parseEvidenceManifestLite,
  pickEvidenceManifest,
  type EvidenceManifestLite,
} from './provenance.ts';
import { diagnoseSnapshotBytes, validateSamplerCoverage } from './sampler.ts';
import { runDeterministicChecks } from './deterministic.ts';

/**
 * Env do gate (antes leituras diretas de Deno.env no index). As keys são
 * opcionais: omitidas, `resolveApiKey` lê o env do runtime (comportamento
 * histórico da edge); o worker passa-as explicitamente via credenciais JIT.
 */
export interface QualityVisionEnv {
  visionApiUrl: string;
  visionGateModel: string;
  visionReasoningEffort: string;
  fallbackApiUrl: string;
  fallbackModel: string;
  fallbackEffort: string;
  visionTimeoutMs: number;
  primaryApiKey?: string;
  fallbackApiKey?: string;
}

export const DEFAULT_QUALITY_VISION_TIMEOUT_MS = 60_000;

/** Storage do gate + leitura do registry publicado (head-first). */
export type QualityPipelineStorage = QualityStorage & {
  readRegistry(projectId: string, revision: number): Promise<string | null>;
};

export function qualityPrimaryGap(env: QualityVisionEnv): string {
  return [
    !env.visionApiUrl && 'VISION_API_URL (ou LLM_API_URL)',
    !env.visionGateModel && 'VISION_GATE_MODEL (ou OPENROUTER_GATE_MODEL/LLM_MODEL)',
  ].filter(Boolean).join(', ');
}

export function qualityFallbackGap(env: QualityVisionEnv): string {
  const credentialPresent = Boolean(env.fallbackApiKey) || hasVideoLlmFallback('VISION');
  return [
    !env.fallbackApiUrl && 'VISION_FALLBACK_API_URL',
    !env.fallbackModel && 'VISION_FALLBACK_MODEL',
    !credentialPresent && 'fallback provider credential',
  ].filter(Boolean).join(', ');
}

// ─── VLM clients (padrão video-quality-gate V3, multi-imagem) ──────────────

const GATE_MAX_ATTEMPTS = 2;
const GATE_RETRY_DELAY_MS = 5000;

function isTransientError(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastResponse: Response | null = null;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < GATE_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('TRANSPORT_DEADLINE_EXCEEDED');
    const res = await fetchBuffered(createVideoLlmFetch(fetch, false, remaining), url, init, remaining, 2 * 1024 * 1024);
    if (!isTransientError(res.status) || attempt === GATE_MAX_ATTEMPTS - 1) return res;
    lastResponse = res;
    console.warn(`[video-v4-quality] transient ${res.status}, retry ${attempt + 1}/${GATE_MAX_ATTEMPTS}`);
    if (deadline - Date.now() <= GATE_RETRY_DELAY_MS) throw new Error('TRANSPORT_DEADLINE_EXCEEDED');
    await new Promise((r) => setTimeout(r, GATE_RETRY_DELAY_MS));
  }
  return lastResponse!;
}

/**
 * Primário: chat completions com N imagens anexas, no endpoint que o env
 * apontar. O shape do thinking/json/headers vem do perfil do URL — enviar o
 * shape de outro provider à Google é um HTTP 400 (probe P3b), e aqui isso seria
 * um 503 em cada projeto.
 */
function primaryVision(env: QualityVisionEnv, model: string, apiUrl: string, effort: string, apiKey?: string): VisionClient {
  const endpoint = visionEndpoint(apiUrl);
  assertModelIdForKind(endpoint.cap.kind, model);
  const key = apiKey ?? resolveApiKey(endpoint.cap.kind);
  const timeoutMs = env.visionTimeoutMs;
  return {
    async score(systemPrompt, userMessage, imagesDataUrl, feedback) {
      const effectiveUser = feedback
        ? `${userMessage}\n\n## Previous attempt failed validation:\n${feedback}\n\nReturn ONLY the corrected JSON object, fixing every issue above.`
        : userMessage;
      const { url, init } = buildChatVisionRequest({
        endpoint,
        apiKey: key,
        model,
        system: systemPrompt,
        prompt: effectiveUser,
        imageUrls: imagesDataUrl,
        reasoningEffort: effort || undefined,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchWithRetry(url, { ...init, signal: controller.signal }, timeoutMs);
      } catch (err) {
        clearTimeout(timer);
        throw new Error(`VLM_UNAVAILABLE: ${endpoint.cap.kind} request failed — ${(err as Error)?.message ?? err}`);
      }
      clearTimeout(timer);
      const out = await readChatVisionResponse(response);
      if (!response.ok) {
        console.error(`[video-v4-quality] primary VLM (${endpoint.cap.host}) failed (${out.status}):`, 'body redacted');
        throw new Error(`VLM_UNAVAILABLE: ${endpoint.cap.kind} HTTP ${out.status}`);
      }
      if (out.thinkingDelta !== null) console.log(`[video-v4-quality] vision thinking_delta=${out.thinkingDelta}`);
      return out.text;
    },
  };
}

/** Fallback uses its own endpoint, model and provider credential. */
function fallbackVision(env: QualityVisionEnv): VisionClient {
  return primaryVision(env, env.fallbackModel, env.fallbackApiUrl, env.fallbackEffort, env.fallbackApiKey);
}

export function createQualityVisionClient(env: QualityVisionEnv): VisionClient | null {
  if (!qualityPrimaryGap(env)) {
    const primary = primaryVision(env, env.visionGateModel, env.visionApiUrl, env.visionReasoningEffort, env.primaryApiKey);
    return { async score(...args) {
      try { return await primary.score(...args); }
      catch (error) {
        if (qualityFallbackGap(env)) throw error;
        console.warn('[video-v4-quality] primary failed; trying configured fallback');
        return fallbackVision(env).score(...args);
      }
    } };
  }
  if (!qualityFallbackGap(env)) return fallbackVision(env);
  return null;
}

/**
 * Localiza `evidence-manifest.json` sob `projects/{id}/evidence/` (um nível
 * de subdiretoria job/revision). Só paths dentro do projeto entram; tudo o
 * resto é ignorado aqui e recusado na seleção. Nunca usa mtime/timestamp.
 */
export async function discoverEvidenceManifestPaths(storage: QualityStorage, projectId: string): Promise<string[]> {
  const prefix = `projects/${projectId}/`;
  const found = new Set<string>();
  let root: string[] = [];
  try {
    root = await storage.list(`${prefix}evidence/`);
  } catch {
    return [];
  }
  const subdirs: string[] = [];
  for (const entry of root) {
    if (!entry.startsWith(prefix)) continue;
    if (entry.endsWith('.json')) found.add(entry);
    else if (!/\.(png|jpg|jpeg|webp|mp4|webm)$/i.test(entry)) subdirs.push(entry);
  }
  for (const sub of subdirs.slice(0, 20)) {
    try {
      const inner = await storage.list(`${sub}/`);
      for (const f of inner) {
        if (f.startsWith(prefix) && f.endsWith('.json')) found.add(f);
      }
    } catch {
      // Subdiretoria ilegível: ignorar, discovery continua.
    }
  }
  return [...found].slice(0, 20);
}

/**
 * Extrai bounds de texto do registry de elementos (best-effort, tolerante):
 * devolve null quando não há bboxes — o check de readability fica `unknown`,
 * nunca `pass` presumido. Sem segredos, sem URLs assinadas nos detalhes.
 */
export function extractTextBounds(
  elementsJson: string | null,
  observed: { width?: number | null; height?: number | null } | null,
): Array<{ id: string; x: number | null; y: number | null; w: number | null; h: number | null; font_px: number | null }> | null {
  if (typeof elementsJson !== 'string' || elementsJson === '' || !observed) return null;
  try {
    const parsed = JSON.parse(elementsJson) as { elements?: unknown };
    if (!parsed || !Array.isArray(parsed.elements)) return null;
    const out: Array<{ id: string; x: number | null; y: number | null; w: number | null; h: number | null; font_px: number | null }> = [];
    for (const raw of parsed.elements) {
      if (!raw || typeof raw !== 'object') continue;
      const el = raw as Record<string, unknown>;
      const type = typeof el.type === 'string' ? el.type.toLowerCase() : '';
      if (type !== 'text' && type !== 'caption' && type !== 'title' && type !== 'subtitle') continue;
      const id = typeof el.id === 'string' ? el.id : `text-${out.length + 1}`;
      const bbox = (el.bbox ?? el.bounds ?? null) as Record<string, unknown> | null;
      const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
      const fontRaw = el.font_px ?? el.fontSize ?? (el.style as Record<string, unknown> | undefined)?.fontSize ?? null;
      out.push({
        id,
        x: bbox ? num(bbox.x) : null,
        y: bbox ? num(bbox.y) : null,
        w: bbox ? num(bbox.w ?? bbox.width) : null,
        h: bbox ? num(bbox.h ?? bbox.height) : null,
        font_px: num(typeof fontRaw === 'string' ? Number(fontRaw) : fontRaw),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Gate de qualidade pós-finalize — o MESMO corpo que a edge corria no task
 * keep-alive. Evidence-manifest da revisão é a única fonte de snapshots
 * (listing global NUNCA dá score); diagnóstico de bytes + QC determinístico
 * ANTES de qualquer chamada paga; VLM com retry transiente ×2 + validação ×1;
 * persiste quality_report.json e devolve a telemetria do manifesto.
 */
export async function runQualityPipeline(
  storage: QualityPipelineStorage,
  projectId: string,
  opts: { expectedRevision: number | null; requestJobId: string | null },
  env: QualityVisionEnv,
): Promise<Record<string, unknown>> {
  const { expectedRevision, requestJobId } = opts;
  const vision = createQualityVisionClient(env);
  if (!vision) {
    return {
      ok: false,
      error: 'QUALITY_VLM_NOT_CONFIGURED',
      detail: `no vision provider configured — primary missing: ${qualityPrimaryGap(env) || 'nothing'}; fallback missing: ${qualityFallbackGap(env) || 'nothing'}`,
    };
  }
  const unknownProvenance = { status: 'unknown', project_id: projectId, expected_revision: expectedRevision };

  // F10.04 passo 0 — discovery de evidence-manifests da revisão em
  // análise. Listing global de snapshots NUNCA é fonte de score.
  const manifestPaths = await discoverEvidenceManifestPaths(storage, projectId);
  const manifestTexts = new Map<string, string>();
  for (const mp of manifestPaths) {
    try {
      const text = await storage.readText(mp);
      if (typeof text === 'string' && text !== '') manifestTexts.set(mp, text);
    } catch {
      // Manifesto ilegível/grande: ignorado, contado como ilegível.
    }
  }
  const parsedManifests: EvidenceManifestLite[] = [];
  let unparseableManifests = manifestPaths.length - manifestTexts.size;
  for (const [mp, text] of manifestTexts) {
    const parsed = parseEvidenceManifestLite(text, mp);
    if (parsed.ok === true) parsedManifests.push(parsed.manifest);
    else unparseableManifests++;
  }
  const picked = pickEvidenceManifest(parsedManifests, { projectId, expectedRevision });

  if (picked.ok === false) {
    // Sem evidence utilizável: NUNCA score fabricado. Legacy sem
    // evidência = unknown (não current por timestamp/mtime); parcial,
    // mismatch, ambíguo e cross-project = erro estruturado. O
    // quality_report.json histórico NÃO é sobrescrito (fica legível).
    if (picked.code === 'EVIDENCE_MISSING' && unparseableManifests === 0) {
      const legacy = resolveQualitySource({
        listingPaths: await storage.list(`projects/${projectId}/snapshots/`),
        evidenceManifest: null,
        projectId,
      });
      const legacyCount = legacy.ok === true && legacy.kind === 'legacy-unverified' ? legacy.snapshots.length : 0;
      if (legacyCount > 0) {
        console.warn(`[video-v4-quality] LEGACY_UNVERIFIED para ${projectId}: ${legacyCount} snapshot(s) legacy sem evidence (sem score)`);
        return {
          ok: false,
          error: 'QUALITY_LEGACY_UNVERIFIED',
          detail: 'Sem evidence-manifest da revisão (worker publica só snapshots legacy, F04-T08/T09): score não fabricado; re-render com evidence resolve. Report histórico preservado.',
          provenance: { ...unknownProvenance, legacy_snapshots: legacyCount },
        };
      }
      console.warn(`[video-v4-quality] no snapshots found for ${projectId}`);
      return {
        ok: false,
        error: 'QUALITY_SNAPSHOTS_MISSING',
        detail: 'Visual quality cannot be evaluated without worker snapshots',
        provenance: unknownProvenance,
      };
    }
    const error = picked.code === 'EVIDENCE_PARTIAL' ? 'QUALITY_EVIDENCE_PARTIAL'
      : picked.code === 'EVIDENCE_MISMATCH' ? 'QUALITY_EVIDENCE_MISMATCH'
      : picked.code === 'EVIDENCE_AMBIGUOUS' ? 'QUALITY_EVIDENCE_AMBIGUOUS'
      : picked.code === 'EVIDENCE_CROSS_PROJECT' ? 'QUALITY_EVIDENCE_CROSS_PROJECT'
      : 'QUALITY_EVIDENCE_MISSING';
    return { ok: false, error, detail: picked.detail.slice(0, 450), provenance: unknownProvenance };
  }

  // F10.04 passo 1 — evidence único, completo, da revisão: scope
  // enforcement (artefactos de outro render/projeto nunca entram).
  const manifest = picked.manifest;
  const manifestRaw = manifestTexts.get(manifest.manifestPath) ?? '';
  const source = resolveQualitySource({
    listingPaths: [],
    evidenceManifest: { revision: manifest.revision, status: manifest.status, snapshots: manifest.snapshots, manifestPath: manifest.manifestPath },
    expectedRevision,
    projectId,
    max: MAX_SNAPSHOTS,
  });
  const evidenceSnapshots = source.ok === true && source.kind === 'evidence' ? source.snapshots : [];
  const rejectedCross = source.ok === true ? source.rejectedCrossProject : [];
  if (evidenceSnapshots.length === 0) {
    return {
      ok: false,
      error: 'QUALITY_EVIDENCE_CROSS_PROJECT',
      detail: 'Snapshots do evidence fora de projects/{id}/ recusados (cross-render/project nunca entra); sem score fabricado',
      provenance: { ...unknownProvenance, revision: manifest.revision, job_id: manifest.job_id },
    };
  }

  // 2. Contexto (opcionais).
  let storyboard: string | null;
  let elementsJson: string | null;
  try {
    [storyboard, elementsJson] = await Promise.all([
      storage.readText(`projects/${projectId}/STORYBOARD.md`),
      storage.readRegistry(projectId, manifest.composition_revision ?? manifest.revision),
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof CompositionPublicationError ? error.code : 'PUBLICATION_READ_FAILED',
      detail: error instanceof Error ? error.message : 'Published registry unavailable', provenance: unknownProvenance };
  }

  // F10.06 passo 2 — diagnóstico dos bytes ANTES de qualquer chamada paga:
  // defeito do sampler (missing/empty/not-png/truncated/duplicate) tem
  // código próprio e nunca vira finding editorial nem proposta de rewrite.
  const seenDigests = new Set<string>();
  const diagnoses: Array<ReturnType<typeof diagnoseSnapshotBytes>> = [];
  const usable: Array<{ path: string; bytes: Uint8Array; digest: string }> = [];
  for (const path of evidenceSnapshots) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await storage.readBinary(path);
    } catch {
      bytes = null;
    }
    const d = diagnoseSnapshotBytes(path, bytes, seenDigests);
    diagnoses.push(d);
    if (d.ok === true) usable.push({ path, bytes: bytes as Uint8Array, digest: d.digest });
  }
  const hardDefective = diagnoses.filter((d) => d.ok === false && d.grade === 'error');
  const defectiveCodes = hardDefective.map((d) => d.ok === false ? d.code : 'UNKNOWN').join(',');
  if (usable.length === 0) {
    return {
      ok: false,
      error: 'QUALITY_SAMPLER_DEFECTIVE',
      detail: `Snapshots do evidence todos defeituosos (${defectiveCodes.slice(0, 200)}); VLM não chamado, sem score fabricado`.slice(0, 450),
      provenance: { ...unknownProvenance, revision: manifest.revision, job_id: manifest.job_id },
    };
  }
  const droppedNames = diagnoses.filter((d) => d.ok === false).map((d) => d.path.split('/').pop() ?? d.path);

  // F10.06 passo 3 — coverage: cenas/cuts/transições + tempos válidos.
  const output0 = manifest.outputs.length > 0 ? manifest.outputs[0] : null;
  const outputDuration = output0 !== null && typeof output0.duration_sec === 'number' && Number.isFinite(output0.duration_sec)
    ? output0.duration_sec
    : null;
  const usableSet = new Set(usable.map((u) => u.path));
  const coverage = validateSamplerCoverage({
    snapshots: manifest.snapshots
      .filter((s) => usableSet.has(s.path ?? s.file ?? ''))
      .map((s) => ({ path: s.path ?? s.file ?? '', scene_id: s.scene_id ?? null, time_s: typeof s.time_s === 'number' ? s.time_s : null })),
    sceneIds: manifest.scene_ids,
    outputDurationSec: outputDuration,
    transitions: null,
  });

  // F10.07 passo 4 — QC determinístico, separado do VLM: corre sempre,
  // mesmo que o provider falhe (o erro do provider é preservado, nunca
  // convertido em score). 5 imagens não validam narração/música/motion.
  const detObserved = output0 === null ? null : {
    width: output0.width ?? null,
    height: output0.height ?? null,
    fps: output0.fps ?? null,
    duration_sec: output0.duration_sec ?? null,
    container: output0.container ?? null,
    codec: output0.codec ?? null,
    size_bytes: output0.size_bytes ?? null,
    audio: output0.audio ?? null,
  };
  const deterministic = runDeterministicChecks({
    observed: detObserved,
    targetDurationSec: null,
    assets: null,
    textElements: extractTextBounds(elementsJson, detObserved),
    snapshotDigests: usable.map((u) => u.digest),
  });
  const detSummary = { failed: deterministic.failed, unknown: deterministic.unknown, audio_checked: deterministic.audio_checked };

  const images: string[] = [];
  for (const u of usable) images.push(pngToDataUrl(u.bytes));

  // 5. VLM call + validação com feedback (×1, padrão runStep V4-2).
  const samplerNote = [
    `Evidence: job ${manifest.job_id} revision ${manifest.revision} (${usable.length}/${evidenceSnapshots.length} snapshots utilizáveis).`,
    coverage.complete
      ? 'Sampler coverage completo.'
      : `Sampler coverage incompleto (limitação registada, não rewrite): cenas descobertas [${coverage.uncovered_scenes.join(',').slice(0, 160)}].`,
    droppedNames.length > 0 ? `Snapshots defeituosos excluídos antes do VLM: ${droppedNames.join(',').slice(0, 160)}.` : '',
    `Determinístico: ${deterministic.failed} fail / ${deterministic.unknown} unknown, audio_checked=${deterministic.audio_checked}.`,
  ].filter(Boolean).join(' ');
  const userMessage = `${buildQualityUserMessage({ storyboard, elementsJson, frameCount: images.length })}\n\n## Sampler/determinístico (factos já verificados; avaliar só o visual)\n${samplerNote}`;
  const providerLabel = qualityPrimaryGap(env) === '' ? 'primary' : 'fallback';
  const providerModel = providerLabel === 'primary' ? env.visionGateModel : env.fallbackModel;
  let lastError = '';
  let report = null;
  for (let attempt = 0; attempt <= 1 && !report; attempt++) {
    try {
      const raw = await vision.score(QUALITY_SYSTEM_PROMPT, userMessage, images, attempt > 0 ? lastError : undefined);
      report = buildQualityReport({
        rawModelJson: raw,
        snapshotPaths: usable.map((u) => u.path),
        projectId,
        nowIso: new Date().toISOString(),
        provenance: {
          jobId: requestJobId ?? manifest.job_id,
          inputRevision: manifest.composition_revision ?? manifest.revision,
          outputRevision: manifest.revision,
          compositionHash: manifest.composition_hash ?? manifest.input_hash ?? null,
          evidenceManifestPath: manifest.manifestPath,
          evidenceManifestDigest: digestManifestText(manifestRaw),
          sampler: coverage,
          deterministic,
          model: providerModel !== '' ? providerModel : null,
          provider: providerLabel,
          limitations: [
            ...(rejectedCross.length > 0 ? [`${rejectedCross.length} artefacto(s) cross-project recusados do set`] : []),
            ...(droppedNames.length > 0 ? [`${droppedNames.length} snapshot(s) defeituoso(s) excluídos antes do VLM (${defectiveCodes.slice(0, 160)})`] : []),
            ...coverage.limitations,
          ],
        },
      });
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
      const unavailable = lastError.startsWith('VLM_UNAVAILABLE');
      console.warn(`[video-v4-quality] attempt ${attempt + 1} failed:`, lastError.slice(0, 300));
      if (unavailable) {
        return {
          ok: false,
          error: 'QUALITY_VLM_UNAVAILABLE',
          detail: lastError.slice(0, 450),
          provenance: { ...unknownProvenance, revision: manifest.revision, job_id: manifest.job_id },
          deterministic: detSummary,
        };
      }
      if (attempt < 1) continue; // VALIDATION_FAILED → retry com feedback
    }
  }
  if (!report) {
    return {
      ok: false,
      error: 'VALIDATION_FAILED',
      detail: lastError.slice(0, 450),
      provenance: { ...unknownProvenance, revision: manifest.revision, job_id: manifest.job_id },
      deterministic: detSummary,
    };
  }

  // 6. Persistir + responder com a telemetria que o orchestrator escreve
  //    no manifesto (steps.quality.score / needs_attention).
  const reportPath = `projects/${projectId}/quality_report.json`;
  await storage.writeText(reportPath, JSON.stringify(report));
  return {
    ok: true,
    artifacts: ['quality_report.json'],
    score: report.score,
    needs_attention: report.needs_attention,
    report_id: report.id,
    status: report.status,
    revision: manifest.revision,
    deterministic: detSummary,
  };
}