/**
 * provenance.ts — F10.04 (V5.34): proveniência versionada do quality report.
 *
 * Módulo PURO dual-runtime (Deno + Node/vitest): sem Deno.*, sem Node-only
 * APIs, imports relativos com extensão `.ts`. O único import externo é zod
 * (mapeado para o pacote local pelo vite config nos testes).
 *
 * Contrato C9: o relatório carrega report ID, input/render revision,
 * coverage/provenance, scores, findings com IDs/cena/tempo e status
 * current/stale/unknown. Campos ausentes em reports legacy geram `unknown`,
 * nunca `current` implícito — e nunca por timestamp/mtime do cliente.
 *
 * Expand-first: leitores (F10.05/F10.09) devem usar `readQualityReport` /
 * `computeReportStatus`, que são tolerantes a v1 (sem proveniência) e a
 * payloads ilegíveis. Reports anteriores permanecem históricos e legíveis;
 * nada aqui reescreve score/provenance legacy.
 */

import { z } from 'zod';

/** Revisão do envelope de proveniência (independente de QUALITY_REPORT_VERSION). */
export const QUALITY_PROVENANCE_VERSION = 1 as const;

/** Estado de frescura de um relatório face à revisão ativa. */
export type QualityReportStatus = 'current' | 'stale' | 'unknown';

// ─── Evidence manifest (leitura tolerante) ───────────────────────────────────
// Subconjunto de RenderEvidenceManifestV1 que o quality consome (ver
// `_shared/renderEffective.ts`, contrato F04 — este é só o view-model
// tolerante do consumidor, não um segundo schema canónico). Campos de
// áudio/container/codec opcionais: o worker ainda não os publica; ausência
// declara medição `unknown`, nunca falha nem presunção.

export interface EvidenceSnapshotLite {
  file?: string;
  path?: string;
  scene_id?: string | null;
  time_s?: number | null;
  sha256?: string | null;
}

export interface EvidenceAudioLite {
  present?: boolean | null;
  codec?: string | null;
  peak_dbfs?: number | null;
  silence_ratio?: number | null;
  duration_sec?: number | null;
}

export interface EvidenceOutputLite {
  name?: string;
  path?: string;
  mime?: string;
  size_bytes?: number | null;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  duration_sec?: number | null;
  container?: string | null;
  codec?: string | null;
  audio?: EvidenceAudioLite | null;
}

export interface EvidenceManifestLite {
  manifestPath: string;
  job_id: string;
  project_id: string;
  /** Revisão da composição/render a que este evidence pertence. */
  revision: number;
  input_hash?: string | null;
  composition_hash?: string | null;
  composition_revision?: number | null;
  cli_version?: string | null;
  generated_at?: string | null;
  scene_ids: string[];
  boundary_ids: string[];
  outputs: EvidenceOutputLite[];
  snapshots: EvidenceSnapshotLite[];
  coverage?: {
    total_windows?: number | null;
    sampled?: number | null;
    skipped?: Array<{ id?: string; reason?: string }>;
    missing?: string[];
  } | null;
  status: 'complete' | 'partial';
}

const EvidenceSnapshotSchema = z.object({
  file: z.string().optional(),
  path: z.string().optional(),
  scene_id: z.string().nullable().optional(),
  time_s: z.number().nullable().optional(),
  sha256: z.string().nullable().optional(),
}).passthrough();

const EvidenceOutputSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  mime: z.string().optional(),
  size_bytes: z.number().nullable().optional(),
  sha256: z.string().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  fps: z.number().nullable().optional(),
  duration_sec: z.number().nullable().optional(),
  container: z.string().nullable().optional(),
  codec: z.string().nullable().optional(),
  audio: z.object({
    present: z.boolean().nullable().optional(),
    codec: z.string().nullable().optional(),
    peak_dbfs: z.number().nullable().optional(),
    silence_ratio: z.number().nullable().optional(),
    duration_sec: z.number().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const EvidenceManifestSchema = z.object({
  job_id: z.string().min(1),
  project_id: z.string().min(1),
  revision: z.number(),
  input_hash: z.string().nullable().optional(),
  composition_hash: z.string().nullable().optional(),
  composition_revision: z.number().nullable().optional(),
  cli_version: z.string().nullable().optional(),
  generated_at: z.string().nullable().optional(),
  scene_ids: z.array(z.string()).default([]),
  boundary_ids: z.array(z.string()).default([]),
  outputs: z.array(EvidenceOutputSchema).default([]),
  snapshots: z.array(EvidenceSnapshotSchema).default([]),
  coverage: z.object({
    total_windows: z.number().nullable().optional(),
    sampled: z.number().nullable().optional(),
    skipped: z.array(z.object({ id: z.string().optional(), reason: z.string().optional() }).passthrough()).optional(),
    missing: z.array(z.string()).optional(),
  }).passthrough().nullable().optional(),
  // Fail-closed: status ausente/inválido NUNCA vira `complete` por defeito.
  status: z.enum(['complete', 'partial']),
}).passthrough();

export type ParseEvidenceResult =
  | { ok: true; manifest: EvidenceManifestLite }
  | { ok: false; code: 'EVIDENCE_UNPARSEABLE' | 'EVIDENCE_INVALID'; detail: string };

/**
 * Parse tolerante de um evidence-manifest.json. Nunca lança; regimes
 * inválidos/ilegíveis recusam com código estruturado (sem score fabricado).
 */
export function parseEvidenceManifestLite(rawText: string | null | undefined, manifestPath: string): ParseEvidenceResult {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { ok: false, code: 'EVIDENCE_UNPARSEABLE', detail: `manifest vazio/ilegível em ${manifestPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, code: 'EVIDENCE_UNPARSEABLE', detail: `manifest com JSON inválido em ${manifestPath}` };
  }
  const validated = EvidenceManifestSchema.safeParse(parsed);
  if (validated.success === false) {
    const issues = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, code: 'EVIDENCE_INVALID', detail: `manifest inválido em ${manifestPath}: ${issues.slice(0, 280)}` };
  }
  const v = validated.data;
  return {
    ok: true,
    manifest: {
      manifestPath,
      job_id: v.job_id,
      project_id: v.project_id,
      revision: Math.floor(v.revision),
      input_hash: v.input_hash ?? null,
      composition_hash: v.composition_hash ?? null,
      composition_revision: v.composition_revision ?? null,
      cli_version: v.cli_version ?? null,
      generated_at: v.generated_at ?? null,
      scene_ids: v.scene_ids,
      boundary_ids: v.boundary_ids,
      outputs: v.outputs,
      snapshots: v.snapshots,
      coverage: v.coverage ?? null,
      status: v.status,
    },
  };
}

// ─── Seleção de evidence (nunca por timestamp/mtime) ─────────────────────────

export type PickEvidenceResult =
  | { ok: true; manifest: EvidenceManifestLite }
  | {
    ok: false;
    code: 'EVIDENCE_MISSING' | 'EVIDENCE_PARTIAL' | 'EVIDENCE_MISMATCH' | 'EVIDENCE_AMBIGUOUS' | 'EVIDENCE_CROSS_PROJECT';
    detail: string;
    revisions?: number[];
  };

/**
 * Escolhe o evidence-manifest da revisão em análise.
 *
 * - `expectedRevision` presente (recheck F10.08 / dispatch): só a revisão
 *   exata serve; divergência recusa (stale), nunca cai no listing global.
 * - Ausente (gate pós-finalize): exige EXATAMENTE um manifest `complete` do
 *   projeto; zero → MISSING (legacy), >1 → AMBIGUOUS (nunca desempatar por
 *   mtime/timestamp — pedir expectedRevision explícito).
 * - Manifests de outro projeto recusam sempre (cross-render/project nunca
 *   entram); são reportados, não usados.
 * - `partial` declara missing sem promover set antigo (contrato F04-T08/T09).
 */
export function pickEvidenceManifest(
  candidates: EvidenceManifestLite[],
  opts: { projectId: string; expectedRevision?: number | null },
): PickEvidenceResult {
  const ours = (candidates ?? []).filter((m) => m && m.project_id === opts.projectId);
  const foreign = (candidates ?? []).filter((m) => m && m.project_id !== opts.projectId);
  if (ours.length === 0) {
    if (foreign.length > 0) {
      return {
        ok: false,
        code: 'EVIDENCE_CROSS_PROJECT',
        detail: `${foreign.length} manifest(s) de outro projeto recusados (cross-project nunca entra); sem evidence de ${opts.projectId}`,
      };
    }
    return { ok: false, code: 'EVIDENCE_MISSING', detail: `sem evidence-manifest para ${opts.projectId} (legacy sem evidência = unknown)` };
  }

  const expected = opts.expectedRevision ?? null;
  if (expected !== null && Number.isFinite(expected)) {
    const match = ours.find((m) => m.revision === expected) ?? null;
    if (match === null) {
      return {
        ok: false,
        code: 'EVIDENCE_MISMATCH',
        detail: `evidence revision(s) [${ours.map((m) => m.revision).join(',')}] ≠ expected ${expected} (stale; recusar, nunca usar listing global)`,
        revisions: ours.map((m) => m.revision),
      };
    }
    if (match.status !== 'complete') {
      return { ok: false, code: 'EVIDENCE_PARTIAL', detail: `evidence r${match.revision} status=${match.status} (parcial declara missing sem promover set antigo)` };
    }
    return { ok: true, manifest: match };
  }

  const complete = ours.filter((m) => m.status === 'complete');
  if (complete.length === 1) return { ok: true, manifest: complete[0] };
  if (complete.length === 0) {
    return { ok: false, code: 'EVIDENCE_PARTIAL', detail: `só manifests parciais (${ours.length}) para ${opts.projectId} (missing declarado, sem promover set antigo)` };
  }
  return {
    ok: false,
    code: 'EVIDENCE_AMBIGUOUS',
    detail: `${complete.length} manifests completos (revisions [${complete.map((m) => m.revision).join(',')}]) sem expectedRevision — recusar em vez de desempatar por mtime`,
    revisions: complete.map((m) => m.revision),
  };
}

/**
 * Snapshots do manifest com scope enforcement: só paths sob
 * `projects/{projectId}/` entram; artefactos de outro render/projeto são
 * rejeitados e contados (nunca silenciosamente incluídos).
 */
export function evidenceSnapshotPaths(
  manifest: EvidenceManifestLite,
  projectId: string,
  max: number,
): { paths: string[]; rejectedCrossProject: string[] } {
  const prefix = `projects/${projectId}/`;
  const paths: string[] = [];
  const rejectedCrossProject: string[] = [];
  for (const s of manifest.snapshots ?? []) {
    const p = (s.path ?? s.file ?? '').trim();
    if (!p) continue;
    if (p.startsWith(prefix)) paths.push(p);
    else rejectedCrossProject.push(p);
  }
  return { paths: paths.slice(0, max), rejectedCrossProject };
}

// ─── Report ID / digest (puros, sem crypto assíncrona) ───────────────────────

/** FNV-1a 32-bit hex — identidade barata e síncrona (não é segurança). */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** ID estável do relatório: `qr_<fnv(project|job|rev|timestamp)>`. */
export function makeReportId(args: { projectId: string; jobId?: string | null; revision?: number | null; nowIso: string }): string {
  const seed = [args.projectId, args.jobId ?? '-', args.revision ?? '-', args.nowIso].join('|');
  return `qr_${fnv1aHex(seed)}${fnv1aHex(`${seed}#2`)}`;
}

/** Digest do manifest lido (amarra report↔evidence sem logar URLs). */
export function digestManifestText(rawText: string): string {
  return `fnv1a:${fnv1aHex(rawText)}:${rawText.length}`;
}

// ─── Leitor tolerante (F10.05/F10.09 usam isto, não acesso direto) ────────────

/**
 * Estado de frescura SEMPRE explícito:
 * - report ausente/ilegível/sem proveniência/sem revisão → `unknown`
 *   (legacy sem evidência é unknown, não válido por timestamp);
 * - revisão igual à ativa → `current`;
 * - revisão diferente → `stale`.
 * `activeRevision` ausente/não-numérico → `unknown` (sem adivinhação).
 * Nunca lança.
 */
export function computeReportStatus(
  reportLike: { input_revision?: unknown; output_revision?: unknown; revision?: unknown } | null | undefined,
  activeRevision: unknown,
): QualityReportStatus {
  if (!reportLike || typeof reportLike !== 'object') return 'unknown';
  const revRaw = reportLike.input_revision ?? reportLike.output_revision ?? reportLike.revision ?? null;
  const rev = typeof revRaw === 'number' && Number.isFinite(revRaw) ? Math.floor(revRaw) : null;
  const active = typeof activeRevision === 'number' && Number.isFinite(activeRevision) ? Math.floor(activeRevision) : null;
  if (rev === null || rev < 1 || active === null || active < 1) return 'unknown';
  return rev === active ? 'current' : 'stale';
}

/**
 * Lê um quality_report.json (v1 legacy ou v2) sem lançar: devolve o essencial
 * para UI/staleness. v1 (sem input_revision/output_revision) → `unknown`.
 * O caller refina com computeReportStatus(report, activeRevision) quando a
 * revisão ativa é conhecida.
 */
export function readQualityReport(rawText: string | null | undefined): {
  readable: boolean;
  version: number | null;
  status: QualityReportStatus;
  score: number | null;
  generated_at: string | null;
  input_revision: number | null;
  output_revision: number | null;
  report_id: string | null;
} {
  const unreadable = {
    readable: false, version: null, status: 'unknown' as QualityReportStatus,
    score: null, generated_at: null, input_revision: null, output_revision: null, report_id: null,
  };
  if (typeof rawText !== 'string' || rawText.trim() === '') return unreadable;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return unreadable;
  }
  if (!parsed || typeof parsed !== 'object') return unreadable;
  const row = parsed as Record<string, unknown>;
  const version = typeof row.version === 'number' && Number.isFinite(row.version) ? Math.floor(row.version) : null;
  const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null;
  const generated_at = typeof row.generated_at === 'string' ? row.generated_at : null;
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && Math.floor(v) >= 1 ? Math.floor(v) : null;
  const input_revision = numOrNull(row.input_revision);
  const output_revision = numOrNull(row.output_revision);
  const report_id = typeof row.id === 'string' ? row.id : typeof row.reportId === 'string' ? row.reportId : null;
  return { readable: true, version, status: 'unknown', score, generated_at, input_revision, output_revision, report_id };
}

/**
 * Conveniência: ler + comparar com a revisão ativa numa só chamada.
 * Report ilegível ou sem revisão → `unknown`.
 */
export function readQualityReportStatus(rawText: string | null | undefined, activeRevision: unknown): QualityReportStatus {
  const read = readQualityReport(rawText);
  if (read.readable === false) return 'unknown';
  if (read.input_revision === null && read.output_revision === null) return 'unknown';
  return computeReportStatus({ input_revision: read.input_revision, output_revision: read.output_revision }, activeRevision);
}
