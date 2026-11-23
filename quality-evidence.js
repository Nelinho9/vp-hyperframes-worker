/**
 * quality-evidence.js — Opção A: captura leve de snapshots da composição
 * publicada atual para reavaliação do Controlo de Qualidade (0 créditos, sem
 * exportação de MP4).
 *
 * - Garante a revisão publicada local via `compositionEditor.ensurePreview`.
 * - Reutiliza um `evidence-manifest.json` completo da mesma revisão/hash caso
 *   já exista na Storage (evita lançar o Chromium desnecessariamente).
 * - Caso contrário, corre apenas `hyperframes snapshot` para um diretório
 *   temporário isolado, constrói o `evidence-manifest.json` (`step:
 *   "quality-snapshot"`) e publica-o na Storage via `persistEvidenceSnapshots`.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildSnapshotCommandArgs,
  parseScenePostEntranceTimes,
  parseSceneWindows,
  renderSnapshotsLegacyFrames,
} from "./thumbnails.js";
import {
  buildCoverageSchedule,
  buildEvidenceManifest,
  evidenceSnapshotPath,
} from "./render-evidence.js";
import { persistEvidenceSnapshots } from "./snapshots-upload.js";
import { renderCompositionHash } from "./composition-editor.js";
import { confinedPath } from "./job-contract.js";

const ARTIFACTS_BUCKET = "video-artifacts";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = Number(process.env.QUALITY_SNAPSHOT_TIMEOUT_MS || 90_000);

function makeError(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

async function findCompleteRevisionEvidence(supabase, projectId, targetRevision, expectedCompositionHash) {
  try {
    const prefix = `projects/${projectId}/evidence`;
    const { data: dirs, error } = await supabase.storage.from(ARTIFACTS_BUCKET).list(prefix, { limit: 50 });
    if (error || !Array.isArray(dirs) || dirs.length === 0) return null;
    for (const entry of dirs.slice(0, 25)) {
      if (!entry?.name || /\.(png|jpg|jpeg|webp|mp4|webm|json)$/i.test(entry.name)) continue;
      const manifestPath = `${prefix}/${entry.name}/evidence-manifest.json`;
      const { data, error: dlErr } = await supabase.storage.from(ARTIFACTS_BUCKET).download(manifestPath);
      if (dlErr || !data) continue;
      let parsed;
      try {
        parsed = JSON.parse(await data.text());
      } catch {
        continue;
      }
      if (
        parsed &&
        parsed.project_id === projectId &&
        Math.floor(Number(parsed.revision)) === targetRevision &&
        parsed.status === "complete" &&
        Array.isArray(parsed.snapshots) &&
        parsed.snapshots.length > 0 &&
        (!expectedCompositionHash || !parsed.composition_hash || parsed.composition_hash === expectedCompositionHash)
      ) {
        return { manifestPath, snapshotsCount: parsed.snapshots.length };
      }
    }
  } catch {
    // Best-effort reuse check; falls through to fresh snapshot capture.
  }
  return null;
}

/**
 * Captura snapshots leves da composição ativa e publica o evidence-manifest
 * correspondente na Storage para o gate de qualidade avaliar sem MP4.
 */
export async function captureQualityEvidence({
  projectId,
  expectedRevision = null,
  jobId = null,
  force = false,
  supabase,
  compositionEditor,
  resolveJobById,
  workDir,
  spawnCommand,
  jobEnv = process.env,
  log = () => {},
}) {
  if (!UUID_RE.test(String(projectId || ""))) {
    throw makeError("INVALID_PROJECT_ID", 400, "Valid project_id UUID required");
  }
  if (!supabase) {
    throw makeError("QUALITY_EVIDENCE_STORAGE_UNAVAILABLE", 503, "Supabase storage unavailable");
  }

  const normalizedExpected =
    typeof expectedRevision === "number" && Number.isFinite(expectedRevision)
      ? Math.floor(expectedRevision)
      : null;

  let head = null;
  if (compositionEditor?.ensurePreview) {
    head = await compositionEditor.ensurePreview(projectId);
  }
  if (head && normalizedExpected !== null && head.revision !== normalizedExpected) {
    throw makeError(
      "QUALITY_EVIDENCE_REVISION_MISMATCH",
      409,
      `Active composition revision (${head.revision}) does not match expected revision (${normalizedExpected})`,
    );
  }

  const job = resolveJobById ? resolveJobById(projectId) : null;
  const indexPath = job?.job_dir ? join(job.job_dir, "index.html") : null;
  if (!job || !indexPath || !existsSync(indexPath)) {
    throw makeError(
      "QUALITY_EVIDENCE_SOURCE_UNAVAILABLE",
      409,
      "Composition preview is not staged yet for quality snapshot capture",
    );
  }

  const targetRevision = normalizedExpected ?? head?.revision ?? job.composition_revision ?? job.revision ?? 1;
  const snapHtml = readFileSync(indexPath, "utf-8");
  const compHash = job.composition_hash || renderCompositionHash(snapHtml);

  if (!force) {
    const existing = await findCompleteRevisionEvidence(supabase, projectId, targetRevision, compHash);
    if (existing) {
      log(`[quality-evidence] reusing complete evidence for ${projectId} r${targetRevision} (${existing.snapshotsCount} snapshots)`);
      return {
        ok: true,
        revision: targetRevision,
        reused: true,
        manifest_path: existing.manifestPath,
        snapshots_count: existing.snapshotsCount,
      };
    }
  }

  const qevJobId = jobId && /^[a-zA-Z0-9_-]{4,64}$/.test(String(jobId))
    ? `qev-${String(jobId)}`
    : `qev-${randomUUID()}`;
  const qevDir = confinedPath(workDir, qevJobId);
  const snapOutDir = join(qevDir, "snapshots");
  mkdirSync(snapOutDir, { recursive: true });

  const fps = job.effective_options?.fps ?? 30;
  let coverageSchedule = { samples: [], skipped: [], missing: [] };
  let snapCmd = process.env.HYPERFRAMES_BIN || "npx";
  let snapArgs = process.env.HYPERFRAMES_BIN
    ? ["snapshot", "--frames", "5", "-o", snapOutDir, job.job_dir]
    : ["hyperframes", "snapshot", "--frames", "5", "-o", snapOutDir, job.job_dir];

  try {
    if (!renderSnapshotsLegacyFrames()) {
      const wins = parseSceneWindows(snapHtml).map((w, i) => ({
        id: `scene-${i + 1}`,
        start: w.start,
        end: w.end,
      }));
      if (wins.length > 0) {
        coverageSchedule = buildCoverageSchedule({ windows: wins, fps, maxSamples: 24 });
        const times = coverageSchedule.samples.map((s) => s.time_s);
        if (times.length > 0) {
          ({ command: snapCmd, args: snapArgs } = buildSnapshotCommandArgs(times, snapOutDir, job.job_dir));
        }
      } else {
        const times = parseScenePostEntranceTimes(snapHtml);
        if (times.length > 0) {
          ({ command: snapCmd, args: snapArgs } = buildSnapshotCommandArgs(times, snapOutDir, job.job_dir));
        }
      }
    }
  } catch (prepErr) {
    log(`[quality-evidence] snapshot prep fallback to --frames 5: ${prepErr?.message ?? prepErr}`);
  }

  try {
    const snapResult = await spawnCommand(snapCmd, snapArgs, {
      timeout: DEFAULT_SNAPSHOT_TIMEOUT_MS,
      env: { ...jobEnv, PRODUCER_LOW_MEMORY_MODE: "true" },
    });
    if (snapResult.timedOut || snapResult.code !== 0) {
      throw makeError(
        "QUALITY_EVIDENCE_SNAPSHOT_FAILED",
        502,
        `hyperframes snapshot exited ${snapResult.code}${snapResult.timedOut ? " (timeout)" : ""}`,
      );
    }

    const snapFiles = existsSync(snapOutDir)
      ? readdirSync(snapOutDir)
          .filter((f) => f.toLowerCase().endsWith(".png"))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      : [];

    if (snapFiles.length === 0) {
      throw makeError("QUALITY_EVIDENCE_NO_SNAPSHOTS", 502, "No PNG snapshots were captured for quality re-evaluation");
    }

    const snapEntries = snapFiles.slice(0, 24).map((file, i) => {
      let hash = "";
      try {
        hash = createHash("sha256").update(readFileSync(join(snapOutDir, file))).digest("hex");
      } catch {
        hash = "";
      }
      const cov = coverageSchedule.samples[i];
      return {
        file,
        scene_id: cov?.scene_id ?? null,
        time_s: cov?.time_s ?? 0,
        sha256: hash,
        path: evidenceSnapshotPath({
          projectId,
          jobId: qevJobId,
          revision: targetRevision,
          file,
        }),
      };
    });

    const sceneIds = [...new Set(coverageSchedule.samples.map((s) => s.scene_id).filter(Boolean))];
    const boundaryIds = coverageSchedule.samples
      .filter((s) => s.kind === "boundary")
      .map((s) => s.scene_id)
      .filter(Boolean);

    const manifest = buildEvidenceManifest({
      jobId: qevJobId,
      projectId,
      step: "quality-snapshot",
      revision: targetRevision,
      inputHash: job.input_hash ?? "",
      compositionHash: compHash,
      effectiveConfigRevision: job.effective_config_revision ?? 0,
      effectiveConfigHash: job.effective_config_hash ?? "",
      sceneIds,
      boundaryIds,
      outputs: [],
      snapshots: snapEntries,
      coverage: {
        total_windows: coverageSchedule.samples.length,
        sampled: snapEntries.length,
        skipped: coverageSchedule.skipped,
        missing: [],
      },
    });

    const uploadErrors = [];
    const ev = await persistEvidenceSnapshots(supabase, {
      projectId,
      jobId: qevJobId,
      revision: targetRevision,
      jobDir: qevDir,
      manifest,
      log,
      onFailure: (msg) => uploadErrors.push(msg),
    });

    if (!ev.manifestPath || ev.published === 0) {
      throw makeError(
        "QUALITY_EVIDENCE_UPLOAD_FAILED",
        502,
        `Failed to publish quality snapshots: ${uploadErrors.join("; ") || "unknown upload error"}`,
      );
    }

    return {
      ok: true,
      revision: targetRevision,
      reused: false,
      manifest_path: ev.manifestPath,
      snapshots_count: ev.published,
    };
  } finally {
    try {
      rmSync(qevDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
