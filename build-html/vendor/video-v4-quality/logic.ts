/**
 * video-v4-quality — V5-P6A (§11): gate de qualidade premium do editor V4.
 *
 * Módulo PURO (dual-runtime Deno/vitest — sem Deno.env/Deno.serve/npm imports;
 * o único import é zod, aliado ao pacote local pelo vite config). O wrapper
 * `index.ts` injeta adapters (storage + fetch) e chama estas funções.
 *
 * Input  : ≤5 snapshots PNG do render final (worker publica em
 *          `projects/{id}/snapshots/frame-N.png`) + STORYBOARD.md +
 *          elements.json (opcionais).
 * Output : `projects/{id}/quality_report.json`
 *          { version:2, source:'vlm', id, project_id, status,
 *            input_revision/output_revision, job_id, evidence_manifest_*,
 *            frames_analyzed, snapshots[], score,
 *            breakdown{visual,consistencia,texto_legivel,compliance},
 *            needs_attention, findings[{id,scene,time_s,origin,...}],
 *            sampler, channels, deterministic, model/provider, limitations }
 *
 * Política honesta (AGENTS.md §3.3): falha total do VLM ⇒ step FAILED com
 * código estruturado (retryable) — NUNCA score fabricado. O gate nunca
 * bloqueia o download (§11.2): abaixo do threshold 7 marca apenas
 * `needs_attention`. Compliance humano/AUP mantém comportamento V3:
 * flag + aviso no relatório, não bloqueio.
 */

import { z } from 'zod';
import type { QualityReportStatus } from './provenance.ts';
import { makeReportId } from './provenance.ts';
import type { DeterministicReport } from './deterministic.ts';
import type { FindingOrigin, SamplerCoverageReport } from './sampler.ts';
import { tagFindingOrigin } from './sampler.ts';

/** Envelope atual do quality report (F10.04: proveniencia versionada). */
export const QUALITY_REPORT_VERSION = 2;
/** Leitor v1 preservado: reports antigos continuam historicos e legiveis. */
export const QUALITY_REPORT_VERSION_V1 = 1;

/** Snapshots analisados por execução (o CLI produz exatamente 5). */
export const MAX_SNAPSHOTS = 5;

/** §11.2: abaixo de 7/10 → needs_attention (não bloqueia). Espelha o V3. */
export const QUALITY_THRESHOLD = 7;

// ─── Contratos ─────────────────────────────────────────────────────────────

export const BREAKDOWN_KEYS = ['visual', 'consistencia', 'texto_legivel', 'compliance'] as const;
export type BreakdownKey = (typeof BREAKDOWN_KEYS)[number];
export type Breakdown = Record<BreakdownKey, number>;

export const FindingSeveritySchema = z.enum(['info', 'warning', 'error']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Finding normalizado (o que fica no quality_report.json). */
export interface QualityFinding {
  /** ID estável dentro do relatório (`f01`, `f02`, …) — para o chat citar (F10.09). */
  id: string;
  /** Cena `scene-N` quando o modelo a identifica; null = global. */
  scene: string | null;
  /** Tempo da cena/snapshot em segundos quando conhecido; VLM não emite (null). */
  time_s: number | null;
  severity: FindingSeverity;
  category: string;
  message: string;
  suggestion?: string;
  /** Origem: editorial (VLM) vs sampler (mismatch — nunca motiva rewrite). */
  origin: FindingOrigin;
  /** Elegível a proposta de rewrite (F10.09 decide; sampler/info/global = false). */
  rewriteEligible: boolean;
}

/** Canais avaliados — scope explícito (C9: 5 imagens não validam tudo). */
export interface QualityChannels {
  visual: 'vlm+deterministic-bounds' | 'deterministic-bounds-only' | 'unchecked';
  audio: 'measured' | 'unchecked';
  motion: 'static-detected' | 'unchecked';
  deterministic: 'executed' | 'no-observed-output';
}

/**
 * Proveniência opcional da geração (F10.04). Ausente = legacy sem evidence:
 * o relatório nasce com status `unknown`, nunca `current` por timestamp.
 */
export interface BuildQualityProvenance {
  jobId?: string | null;
  inputRevision?: number | null;
  outputRevision?: number | null;
  compositionHash?: string | null;
  evidenceManifestPath?: string | null;
  evidenceManifestDigest?: string | null;
  sampler?: SamplerCoverageReport | null;
  deterministic?: DeterministicReport | null;
  model?: string | null;
  provider?: string | null;
  limitations?: string[] | null;
}

/** Envelope completo persistido em projects/{id}/quality_report.json. */
export interface QualityReport {
  version: number;
  source: 'vlm';
  generated_at: string;
  frames_analyzed: number;
  snapshots: string[];
  score: number;
  breakdown: Breakdown;
  needs_attention: boolean;
  findings: QualityFinding[];
  /** ID estável do relatório (`qr_…`). */
  id: string;
  project_id: string;
  /** Frescura na geração: `current` com evidence da revisão; senão `unknown`. */
  status: QualityReportStatus;
  /** Revisão da composição analisada (input). */
  input_revision: number | null;
  /** Revisão do render/evidence analisado (output). */
  output_revision: number | null;
  job_id: string | null;
  composition_hash: string | null;
  evidence_manifest_path: string | null;
  evidence_manifest_digest: string | null;
  sampler: SamplerCoverageReport | null;
  channels: QualityChannels;
  deterministic: DeterministicReport | null;
  model: string | null;
  provider: string | null;
  limitations: string[];
}

/**
 * Output esperado do VLM — tolerante a campos extra/ausentes; a normalização
 * (clamp, cena inválida→null, severidade default) acontece em normalizeVlm().
 */
export const VlmOutputSchema = z.object({
  overall: z.number().optional(),
  breakdown: z.object({
    visual: z.number(),
    consistencia: z.number(),
    texto_legivel: z.number(),
    compliance: z.number(),
  }),
  findings: z.array(z.object({
    scene: z.string().nullable().optional(),
    severity: FindingSeveritySchema.optional(),
    category: z.string().optional(),
    message: z.string(),
    suggestion: z.string().optional(),
  })),
});

export type VlmOutput = z.infer<typeof VlmOutputSchema>;

// ─── Adapters (injetáveis para testes) ─────────────────────────────────────

export interface QualityStorage {
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  writeText(path: string, content: string): Promise<void>;
}

/** Cliente VLM mínimo — o wrapper implementa OpenRouter/kie.ai. */
export interface VisionClient {
  /**
   * @param feedback erro de validação da tentativa anterior (quando presente,
   *                 a nova chamada pede a correção — padrão runStep V4-2).
   */
  score(
    systemPrompt: string,
    userMessage: string,
    imagesDataUrl: string[],
    feedback?: string,
  ): Promise<string>;
}

// ─── Seleção de snapshots ──────────────────────────────────────────────────

const SNAPSHOT_RE = /frame-(\d+)\.png$/i;

/**
 * F04-T10: correlacionar quality ao finalize — consome só o evidence manifest
 * completo da revisão atual; legacy sem evidence = LEGACY_UNVERIFIED, sem
 * score fabricado. Listing global nunca substitui evidence missing.
 */
/**
 * F04-T10 + F10.04: correlacionar quality ao finalize — consome só o evidence
 * manifest completo da revisão atual; legacy sem evidence = LEGACY_UNVERIFIED,
 * sem score fabricado. Listing global nunca substitui evidence missing.
 * F10.04: `projectId` aplica scope enforcement — paths fora de
 * `projects/{id}/` são rejeitados e contados, nunca incluídos.
 */
export type QualitySourceResolution =
  | { ok: true; kind: 'evidence'; snapshots: string[]; manifestPath: string; revision: number; rejectedCrossProject: string[] }
  | { ok: true; kind: 'legacy-unverified'; snapshots: string[]; reason: 'LEGACY_UNVERIFIED'; rejectedCrossProject: string[] }
  | { ok: false; code: 'EVIDENCE_MISSING' | 'EVIDENCE_PARTIAL'; detail: string };

export function resolveQualitySource(args: {
  listingPaths: string[];
  evidenceManifest?: { revision: number; status: 'complete' | 'partial'; snapshots: Array<{ file?: string; path?: string }> ; manifestPath?: string } | null;
  expectedRevision?: number | null;
  projectId?: string | null;
  max?: number;
}): QualitySourceResolution {
  const max = args.max ?? MAX_SNAPSHOTS;
  const prefix = typeof args.projectId === 'string' && args.projectId !== '' ? `projects/${args.projectId}/` : null;
  const inScope = (p: string): boolean => prefix === null || p.startsWith(prefix);
  const ev = args.evidenceManifest ?? null;
  if (ev && typeof ev.revision === 'number') {
    if (args.expectedRevision !== null && args.expectedRevision !== undefined && ev.revision !== args.expectedRevision) {
      return { ok: false, code: 'EVIDENCE_MISSING', detail: `evidence revision ${ev.revision} ≠ expected ${args.expectedRevision} (stale; recusar, nunca usar listing global)` };
    }
    if (ev.status !== 'complete') {
      return { ok: false, code: 'EVIDENCE_PARTIAL', detail: `evidence ${ev.revision} status=${ev.status} (parcial declara missing sem promover set antigo)` };
    }
    const all = (ev.snapshots ?? []).map((s) => s.path ?? s.file ?? '').filter(Boolean);
    const rejectedCrossProject = all.filter((p) => !inScope(p));
    const snaps = all.filter(inScope).slice(0, max);
    if (snaps.length === 0) {
      return {
        ok: false,
        code: 'EVIDENCE_MISSING',
        detail: rejectedCrossProject.length > 0
          ? `evidence só com artefactos cross-project recusados (${rejectedCrossProject.length}; outro render/projeto nunca entra)`
          : 'evidence manifest completo sem snapshots',
      };
    }
    return { ok: true, kind: 'evidence', snapshots: snaps, manifestPath: ev.manifestPath ?? '', revision: ev.revision, rejectedCrossProject };
  }
  // Sem evidence da revisão atual: legacy, sem score fabricado.
  const scoped = (args.listingPaths ?? []).filter(inScope);
  const rejectedCrossProject = prefix !== null ? (args.listingPaths ?? []).filter((p) => !inScope(p)) : [];
  const legacy = selectSnapshotPaths(scoped, max);
  return { ok: true, kind: 'legacy-unverified', snapshots: legacy, reason: 'LEGACY_UNVERIFIED', rejectedCrossProject };
}

/**
 * Do listing de storage, escolhe até MAX_SNAPSHOTs `frame-N.png` por ordem
 * numérica (frame-1 é o primeiro frame da composição).
 * F04-T10: só para legacy LEGACY_UNVERIFIED; projetos novos exigem evidence manifest.
 */
export function selectSnapshotPaths(paths: string[], max = MAX_SNAPSHOTS): string[] {
  const numbered: Array<{ n: number; path: string }> = [];
  for (const p of paths ?? []) {
    const m = SNAPSHOT_RE.exec(p);
    if (m) numbered.push({ n: Number(m[1]), path: p });
  }
  numbered.sort((a, b) => a.n - b.n);
  return numbered.slice(0, max).map((x) => x.path);
}

/** Binary PNG → data URL (input do VLM). */
export function pngToDataUrl(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

// ─── Prompt ────────────────────────────────────────────────────────────────

export const QUALITY_SYSTEM_PROMPT = [
  'You are a professional video quality assessor reviewing frames of a short promotional video composition.',
  'Score each criterion from 1 to 10:',
  '- visual: overall visual quality (composition, lighting, color harmony, dynamic motion vs static picture).',
  '- consistencia: consistency ACROSS frames (brand colors, typography, spacing, style coherence).',
  '- texto_legivel: text legibility (contrast, size, truncation, overlap with imagery).',
  '- compliance: content policy safety. Any humans/faces/body parts or unsafe content must LOWER this score AND produce a finding with category "compliance".',
  '- motion (ANTI-STATIC GATE): if all sampled frames are completely identical (a single static picture with no scene changes, animations or motion), lower visual score to <= 4, mark category "motion", severity "error", and emit a finding stating that the video lacks scene progression or motion.',
  'Report concrete, actionable findings (max 8). Each finding may reference the scene id "scene-N" (N starting at 1, left to right) when the issue belongs to one scene.',
  'Respond ONLY with JSON: {"overall": number|null, "breakdown": {"visual": N, "consistencia": N, "texto_legivel": N, "compliance": N}, "findings": [{"scene": "scene-N"|null, "severity": "info"|"warning"|"error", "category": string, "message": string, "suggestion": string}]}.',
].join(' ');

export interface QualityContextInput {
  storyboard?: string | null;
  elementsJson?: string | null;
  frameCount: number;
}

/** Compacta o registry de elementos para o prompt (ids/cenas/textos curtos). */
export function compactElementsSummary(elementsRaw: string | null | undefined, maxChars = 2400): string {
  if (!elementsRaw) return '(elements registry unavailable)';
  try {
    const parsed = JSON.parse(elementsRaw) as { elements?: Array<{ id?: string; type?: string; sceneId?: string | null; text?: string }> };
    const rows = (parsed.elements ?? []).slice(0, 60).map((e) => {
      const text = typeof e.text === 'string' ? e.text.slice(0, 60) : '';
      return `- ${e.id ?? '?'} [${e.type ?? '?'}] scene=${e.sceneId ?? '?'}${text ? ` text="${text}"` : ''}`;
    });
    const out = rows.join('\n');
    return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out || '(empty registry)';
  } catch {
    return '(elements registry malformed)';
  }
}

export function buildQualityUserMessage(ctx: QualityContextInput): string {
  const storyboard = ctx.storyboard?.trim()
    ? ctx.storyboard.trim().slice(0, 2000)
    : '(storyboard unavailable)';
  const scenesHint = ctx.frameCount > 1
    ? `Frames are ordered left-to-right in time across ${ctx.frameCount} sampled points of the composition.`
    : 'Only one frame was available.';
  return [
    `Assess the ${ctx.frameCount} attached frame(s) of this video composition.`,
    scenesHint,
    '',
    '## Storyboard (context)',
    storyboard,
    '',
    '## Elements registry',
    compactElementsSummary(ctx.elementsJson),
    '',
    'Return ONLY the JSON object described in the system message.',
  ].join('\n');
}

// ─── Normalização + scoring ────────────────────────────────────────────────

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(0, Math.round(n * 10) / 10));
}

/** `scene-12`, `Scene 3`, `scene-4-extra` → `scene-N`; resto → null. */
export function normalizeSceneId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^scene[-_ ]?(\d{1,3})$/i.exec(raw.trim()) ?? /^(scene[-_ ]?\d{1,3})/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(/\d{1,3}/.exec(m[1])?.[0]);
  return Number.isFinite(n) && n > 0 ? `scene-${n}` : null;
}

/**
 * Valida o output do VLM contra o schema, agrega o score (overall do modelo,
 * senão média do breakdown) e devolve o relatório completo. Lança em payload
 * inválido — o caller decide o retry/policy.
 */
/**
 * Valida o output do VLM contra o schema, agrega o score (overall do modelo,
 * senão média do breakdown) e devolve o relatório completo. Lança em payload
 * inválido — o caller decide o retry/policy.
 *
 * F10.04: `provenance` amarra o relatório à revisão analisada (report ID,
 * input/output revision, evidence manifest, sampler, determinístico, modelo).
 * Ausente = legacy sem evidence ⇒ status `unknown` com limitações explícitas
 * (nunca `current` por timestamp). Findings ganham IDs estáveis e etiqueta de
 * origem (sampler-mismatch nunca motiva rewrite — F10.06).
 */
export function buildQualityReport(input: {
  rawModelJson: string;
  snapshotPaths: string[];
  projectId: string;
  nowIso: string;
  provenance?: BuildQualityProvenance | null;
}): QualityReport {
  // Free-tier models embrulham JSON em cercas/comentário — extrair o objeto.
  const start = input.rawModelJson.indexOf('{');
  const end = input.rawModelJson.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('VLM response contained no JSON object');
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(input.rawModelJson.slice(start, end + 1));
  } catch {
    throw new Error('VLM response JSON unparseable');
  }

  const validated = VlmOutputSchema.safeParse(parsedUnknown);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`VALIDATION_FAILED: ${issues.slice(0, 300)}`);
  }
  const out = validated.data;

  const breakdown: Breakdown = {
    visual: clampScore(out.breakdown.visual),
    consistencia: clampScore(out.breakdown.consistencia),
    texto_legivel: clampScore(out.breakdown.texto_legivel),
    compliance: clampScore(out.breakdown.compliance),
  };
  const values = BREAKDOWN_KEYS.map((k) => breakdown[k]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const score = clampScore(typeof out.overall === 'number' && Number.isFinite(out.overall) ? out.overall : mean);

  const findings: QualityFinding[] = out.findings.slice(0, 12).map((f, i) => {
    const scene = normalizeSceneId(f.scene);
    const severity = f.severity ?? 'info';
    const category = (f.category ?? 'general').slice(0, 40);
    const message = f.message.slice(0, 400);
    const suggestion = typeof f.suggestion === 'string' && f.suggestion.trim() ? f.suggestion.slice(0, 300) : undefined;
    const tagged = tagFindingOrigin({ scene, severity, category, message, suggestion });
    return {
      id: `f${String(i + 1).padStart(2, '0')}`,
      scene,
      time_s: null,
      severity,
      category,
      message,
      ...(suggestion !== undefined ? { suggestion } : {}),
      origin: tagged.origin,
      rewriteEligible: tagged.rewriteEligible,
    };
  });

  const prov = input.provenance ?? null;
  const det = prov?.deterministic ?? null;
  const inputRevision = typeof prov?.inputRevision === 'number' && Number.isFinite(prov.inputRevision)
    ? Math.floor(prov.inputRevision)
    : null;
  const outputRevision = typeof prov?.outputRevision === 'number' && Number.isFinite(prov.outputRevision)
    ? Math.floor(prov.outputRevision)
    : null;
  const hasRevision = (inputRevision !== null && inputRevision >= 1) || (outputRevision !== null && outputRevision >= 1);
  const limitations = [...(prov?.limitations ?? [])];
  if (prov === null) {
    limitations.push('proveniência legacy: sem evidence-manifest da revisão (unknown; nunca current por timestamp/mtime)');
  }
  if (det === null) {
    limitations.push('sem QC determinístico nesta execução: dims/duração/áudio não medidos pelo edge (5 imagens não validam narração, música ou movimento contínuo)');
  }

  return {
    version: QUALITY_REPORT_VERSION,
    source: 'vlm',
    generated_at: input.nowIso,
    frames_analyzed: input.snapshotPaths.length,
    snapshots: input.snapshotPaths,
    score,
    breakdown,
    needs_attention: score < QUALITY_THRESHOLD,
    findings,
    id: makeReportId({ projectId: input.projectId, jobId: prov?.jobId ?? null, revision: inputRevision ?? outputRevision, nowIso: input.nowIso }),
    project_id: input.projectId,
    status: hasRevision ? 'current' : 'unknown',
    input_revision: inputRevision,
    output_revision: outputRevision,
    job_id: typeof prov?.jobId === 'string' ? prov.jobId : null,
    composition_hash: typeof prov?.compositionHash === 'string' ? prov.compositionHash : null,
    evidence_manifest_path: typeof prov?.evidenceManifestPath === 'string' ? prov.evidenceManifestPath : null,
    evidence_manifest_digest: typeof prov?.evidenceManifestDigest === 'string' ? prov.evidenceManifestDigest : null,
    sampler: prov?.sampler ?? null,
    channels: {
      visual: 'vlm+deterministic-bounds',
      audio: det !== null && det.audio_checked ? 'measured' : 'unchecked',
      motion: det !== null && det.channels.motion === 'static-detected' ? 'static-detected' : 'unchecked',
      deterministic: det !== null ? 'executed' : 'no-observed-output',
    },
    deterministic: det,
    model: typeof prov?.model === 'string' ? prov.model : null,
    provider: typeof prov?.provider === 'string' ? prov.provider : null,
    limitations,
  };
}