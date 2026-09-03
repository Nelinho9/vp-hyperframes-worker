/**
 * VisttaPro HyperFrames Render Worker
 *
 * Receives render jobs via HTTP, runs the HyperFrames pipeline headless,
 * and uploads results to Supabase Storage. Designed for Coolify deployment.
 *
 * Endpoints:
 *   GET  /health                  — health check
 *   GET  /healthz                 — liveness probe (uptime + active jobs, V4-04D)
 *   POST /job                     — submit a render job
 *   GET  /job/:id/status          — poll job status
 *   POST /patch/:id               — apply click-to-edit patches (linkedom,
 *                                   persisted, V4-04C — replaces the old
 *                                   text-only /job/:id/patch PoC)
 *   POST /restructure/:id         — rewrite the timeline from editor scenes
 *                                   (durations/starts/removals, V4-04C)
 *   GET  /preview/:id             — serve hyperframes preview for a project
 *   POST /supervise               — regista um projeto no supervisor durável da
 *                                   pipeline V4 (V5.14 F7; auth worker-secret)
 *   GET  /supervision             — projetos supervisionados (diagnóstico de deploy)
 */

import express from "express";
import { execSync, spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename, dirname } from "path";
import { randomUUID } from "crypto";
import { pathToFileURL, fileURLToPath } from "url";
import { injectPreviewHelper, injectPreviewRuntime } from "./preview-helper.js";
import { verifyPreviewToken } from "./preview-token.js";
import { applyPatchesLinkedom, applyTimelineRestructure, normalizeClipWindows } from "./patch-engine.js";
import { sanitizeCompositionTweens, extractLintFindings } from "./composition-sanitizer.js";
import { lintClipWindows } from "./window-lint.js";
import {
  classifyCheckEnvelope,
  extractCheckJson,
  loadVendoredRuntimeBundles,
  prepareOfflineFonts,
  sanitizeCompositionForOffline,
  VENDORED_GSAP_ASSET_PATH,
} from "./runtime-vendor.js";
import { prestageExternalMedia } from "./media-preloader.js";
import { compositionStoragePath, persistCompositionArtifact } from "./composition-persist.js";
import { captureThumbnails, computeArtifactHash } from "./thumbnails.js";
import { deriveElements, persistElementsArtifact } from "./elements-registry.js";
import { persistRenderSnapshots } from "./snapshots-upload.js";
import {
  createSupervisionRegistry,
  normalizeDriver,
  startSupervision,
  supervisorEnabled,
} from "./pipeline-runner.js";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8787;
const WORK_DIR = process.env.WORK_DIR || "/tmp/hyperframes-worker";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ORCHESTRATOR_PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";
// V4-3g.5 (R5): quando definido, GET /preview/:id exige ?token= HMAC válido
// (mesmo segredo que VIDEO_V4_PREVIEW_SECRET no orchestrator edge).
const PREVIEW_SECRET = process.env.PREVIEW_SECRET || "";
// V4-04C: server-to-server auth para /patch/:id + /restructure/:id — a rota
// Vercel envia o secret de serviço (VIDEO_V4_CALLBACK_SECRET no lado Vercel,
// partilhado aqui como WORKER_SECRET). Sem nenhum dos dois secrets, as rotas
// de escrita recusam-se (503) em vez de ficarem abertas.
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const runtimeBundles = loadVendoredRuntimeBundles();

export function createSupabaseStorageClient(url, key, factory = createClient, warn = console.warn) {
  if (!url || !key) {
    const missing = [!url ? "SUPABASE_URL" : null, !key ? "SUPABASE_KEY" : null].filter(Boolean).join(", ");
    const error = `missing ${missing}`;
    warn(`SUPABASE_CLIENT_UNAVAILABLE: ${error}`);
    return { client: null, error };
  }
  try {
    return { client: factory(url, key), error: null };
  } catch (err) {
    const error = err?.message ?? String(err);
    warn(`SUPABASE_CLIENT_UNAVAILABLE: ${error}`);
    return { client: null, error };
  }
}

const supabaseConfig = createSupabaseStorageClient(SUPABASE_URL, SUPABASE_KEY);
const supabase = supabaseConfig.client;

export function recordUploadFailure(uploadErrors, channel, error, warn = console.warn) {
  const message = error?.message ?? String(error);
  if (!(channel in uploadErrors)) uploadErrors[channel] = message;
  warn(`SUPABASE_UPLOAD_FAILED ${channel}: ${message}`);
}

export function buildDoneCallbackPayload(job, timings, uploaded, uploadErrors) {
  const payload = {
    job_id: job.id,
    project_id: job.project_id,
    step: job.step,
    status: "done",
    timings,
    uploaded,
    total_ms: job.total_ms,
  };
  if (Object.keys(uploadErrors).length > 0) payload.upload_errors = uploadErrors;
  if (job.window_normalization_warning) {
    payload.window_normalization_warning = job.window_normalization_warning;
  }
  return payload;
}

export async function awaitStagedUploads(job, uploaded = job.uploaded || {}) {
  if (job.compositionUploadPromise) {
    uploaded.composition_html = await job.compositionUploadPromise;
  }
  if (job.elementsUploadPromise) {
    uploaded.composition_elements = await job.elementsUploadPromise;
  }
  job.uploaded = uploaded;
  return uploaded;
}

// ── V5.14 F7: supervisor durável da pipeline V4 ─────────────────────
// As edge functions têm teto de wall-clock; este contentor não. Ao ser
// registado pelo orquestrador (`POST /supervise`), o projeto passa a ser
// "pressionado" a cada 15-60s até o orquestrador dizer que não há nada a fazer
// — o worker NÃO interpreta o manifesto, só obedece ao `action` do /status
// (invariante P13). Falhar isto nunca custa a pipeline: o self-chain edge e o
// watchdog pg_cron (1min) continuam a fazer o seu trabalho.
export const supervision = createSupervisionRegistry();

// Ritmo de polling (teste/ajuste operacional; default = plano §3 F7).
const SUPERVISOR_TICK_MS = Number(process.env.PIPELINE_SUPERVISOR_TICK_MS) || 15_000;

/**
 * Regista um projeto para supervisão.
 *
 * @param {string} projectId
 * @param {{ driver?: object } | null} body corpo do /supervise (contrato do
 *   orquestrador); `null` ⇒ deriva de SUPABASE_URL + WORKER_SECRET (boot).
 * @returns {{ supervised: boolean, reason?: string, status?: number }}
 */
export function superviseProject(projectId, body) {
  if (!supervisorEnabled(process.env)) return { supervised: false, reason: "disabled" };
  const resolved = normalizeDriver(body, process.env, projectId);
  if (!resolved.ok) return { supervised: false, reason: resolved.error, status: 400 };
  const started = startSupervision(
    supervision,
    {
      fetchImpl: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (msg) => console.log(msg),
    },
    projectId,
    resolved.driver,
    { tickMs: SUPERVISOR_TICK_MS },
  );
  return started.started ? { supervised: true } : { supervised: false, reason: started.reason };
}

// ─ In-memory job store (prototype; use DB in production) ───────────
const jobs = new Map();
// Map project_id → job_id for preview lookup
const projectJobs = new Map();

// ── Job persistence (V4-3g.3, B6) ──────────────────────────────────
// POST /job grava um marcador job.json no dir do job; no boot, o scan de
// WORK_DIR repovoa jobs/projectJobs — os previews sobrevivem a restarts
// (o volume worker-data já persiste os ficheiros entre deploys).
function writeJobMarker(jobDir, marker) {
  try {
    writeFileSync(join(jobDir, "job.json"), JSON.stringify(marker));
  } catch (err) {
    console.warn(`[worker] failed to write job.json in ${jobDir}: ${err.message}`);
  }
}

export function rehydrateJobs() {
  let entries;
  try {
    entries = readdirSync(WORK_DIR, { withFileTypes: true });
  } catch {
    return; // WORK_DIR inexistente — primeiro boot
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = join(WORK_DIR, entry.name);
    try {
      const markerPath = join(jobDir, "job.json");
      if (!existsSync(markerPath)) continue;
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      if (!marker?.job_id || !marker?.project_id) continue;
      // Sem index.html não há nada servível — skip tolerante.
      if (!existsSync(join(jobDir, "index.html"))) continue;
      found.push({ marker, jobDir });
    } catch (err) {
      console.warn(`[worker] rehydrate: skipping ${entry.name}: ${err.message}`);
    }
  }
  // O job MAIS RECENTE por projeto ganha o mapping (o build faz overwrite
  // do placeholder staged no /start).
  found.sort((a, b) => String(a.marker.created_at ?? "").localeCompare(String(b.marker.created_at ?? "")));
  for (const { marker, jobDir } of found) {
    jobs.set(marker.job_id, {
      id: marker.job_id,
      project_id: marker.project_id,
      step: marker.step || "render",
      status: "staged",
      created_at: marker.created_at || new Date().toISOString(),
      job_dir: jobDir,
    });
    projectJobs.set(marker.project_id, marker.job_id);
  }
  if (found.length) console.log(`[worker] rehydrated ${found.length} job(s) from ${WORK_DIR}`);

  // V5.14 F7: um contentor que reinicia a meio de um render perde o callback — o
  // projeto ficaria pendurado até ao watchdog. Re-registrar a supervisão dos
  // renders recentes fecha esse buraco. Só markers dentro do teto de vida do
  // job (25min): um render mais velho já foi tratado pela retoma do orquestrador,
  // e um projeto já terminado sai logo no primeiro tick (`action: idle`).
  const SUPERVISE_REHYDRATE_MAX_AGE_MS = 25 * 60 * 1000;
  for (const [projectId, jobId] of projectJobs) {
    const job = jobs.get(jobId);
    if (!job || job.step === "preview") continue;
    const created = Date.parse(job.created_at ?? "");
    if (Number.isNaN(created) || Date.now() - created > SUPERVISE_REHYDRATE_MAX_AGE_MS) continue;
    const out = superviseProject(projectId, null);
    if (out.supervised) console.log(`[worker] supervisão re-registrada no boot para ${projectId}`);
  }
}

rehydrateJobs();

/**
 * V4-3f.7: execSync failures carry stdout/stderr Buffers on the error
 * object. Surface them in the job error so the orchestrator (and the
 * Studio UI) shows actionable lint findings instead of the opaque
 * "Command failed: npx hyperframes lint ..." message.
 *
 * V4-3f.11: keep BOTH ends when truncating. The head of CLI output is
 * progress chatter; the actionable failure line sits at the tail — the
 * old head-keep truncation was hiding the actual render error.
 */
export function formatExecError(err, { limit = 4000 } = {}) {
  const base = err?.message ?? String(err);
  const detail = [err?.stderr, err?.stdout]
    .map((b) => (b ? b.toString() : ""))
    .filter((s) => s.trim())
    .join("\n")
    .trim();
  if (!detail) return base;
  const full = `${base}\n${detail}`;
  if (full.length <= limit) return full;
  const marker = "\n[…truncated…]\n";
  const headSize = Math.floor(limit * 0.25);
  const tailSize = limit - headSize - marker.length;
  return `${full.slice(0, headSize)}${marker}${full.slice(-tailSize)}`;
}

/** Upload an artifact using the signed PUT URL supplied by the orchestrator. */
export async function uploadToSignedUrl(url, body, contentType) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(`signed upload failed (${response.status})${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  }
}

/** Run a command while retaining stdout/stderr even when it exits non-zero. */
export function spawnCommand(command, args, { timeout = 60000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function runCheck(jobDir) {
  const command = process.env.HYPERFRAMES_BIN || "npx";
  const args = process.env.HYPERFRAMES_BIN
    ? ["check", "--json", jobDir]
    : ["hyperframes", "check", "--json", jobDir];
  const result = await spawnCommand(command, args, {
    timeout: 60000,
    env: { ...process.env, CHROME_PATH },
  });
  if (result.timedOut) {
    const error = new Error(`Command timed out: ${command} ${args.join(" ")}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  const envelope = extractCheckJson(result.stdout) ?? extractCheckJson(result.stderr);
  if (!envelope) {
    const error = new Error(`Command failed: ${command} ${args.join(" ")}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.code = result.code;
    throw error;
  }

  const classified = classifyCheckEnvelope(envelope);
  if (!classified.ok) {
    const findingText = classified.fatal
      .map((finding) => `${finding.code ?? "runtime_error"}: ${finding.message ?? "unknown error"}`)
      .join("\n");
    const error = new Error(`HyperFrames check failed${findingText ? `\n${findingText}` : ""}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.code = result.code;
    throw error;
  }
  if (classified.warnings.length || result.code !== 0) {
    console.warn(`[worker] hyperframes check continued with ${classified.warnings.length} tolerated warning(s)`);
  }
  return { envelope, classified, result };
}

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), chrome: CHROME_PATH });
});

// V4-04D §2.5: liveness probe — lets the Studio poll distinguish
// "worker down" from "composition not staged yet".
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    active_jobs: jobs.size,
  });
});

// Vendored browser dependencies are also exposed for local compositions that
// refer to the worker runtime by URL. Normal build output is inline, but these
// routes make the worker useful for previews and provide a deterministic
// fallback without reaching a public CDN.
function runtimeCors(_req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
}
app.options("/runtime/hyperframes.min.js", runtimeCors);
app.options("/runtime/gsap.min.js", runtimeCors);
app.get("/runtime/hyperframes.min.js", runtimeCors, (_req, res) => {
  if (!runtimeBundles.hyperframes) return res.status(404).json({ error: "hyperframes runtime unavailable" });
  res.type("application/javascript").send(runtimeBundles.hyperframes);
});
app.get("/runtime/gsap.min.js", runtimeCors, (_req, res) => {
  if (!runtimeBundles.gsap) return res.status(404).json({ error: "gsap runtime unavailable" });
  res.type("application/javascript").send(runtimeBundles.gsap);
});

// V5-P5B §2.1: biblioteca BGM curated vendida no container (assets públicos
// de biblioteca — mesmo regime CORS das rotas /runtime). catalog.json é a
// mesma tabela partilhada com o passo de áudio (fonte única: o gerador).
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const BGM_DIR = join(ROOT_DIR, "bgm");
const bgmCache = new Map();
function loadBgmAsset(name) {
  if (bgmCache.has(name)) return { ok: true, data: bgmCache.get(name) };
  const path = join(BGM_DIR, name);
  try {
    const data = readFileSync(path);
    bgmCache.set(name, data);
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}
app.options("/bgm/catalog.json", runtimeCors);
app.options("/bgm/:file", runtimeCors);
app.get("/bgm/catalog.json", runtimeCors, (_req, res) => {
  const asset = loadBgmAsset("catalog.json");
  if (!asset.ok) return res.status(404).json({ error: "bgm catalog unavailable" });
  res.type("application/json").set("Cache-Control", "public, max-age=300").send(asset.data);
});
app.get("/bgm/:file", runtimeCors, (req, res) => {
  const file = String(req.params.file ?? "");
  // basename-guard + whitelist de extensão (biblioteca é só mp3).
  if (!file || file !== basename(file) || !/\.mp3$/i.test(file)) {
    return res.status(404).json({ error: "invalid bgm file" });
  }
  const asset = loadBgmAsset(file);
  if (!asset.ok) return res.status(404).json({ error: "bgm file not found" });
  res
    .type("audio/mpeg")
    .set("Cache-Control", "public, max-age=86400")
    .send(asset.data);
});

// ── Submit job ──────────────────────────────────────────────────────
app.post("/job", async (req, res) => {
  const body = req.body;
  const project_id = body.project_id;
  const step = body.step;
  // Accept both formats: direct index_html OR nested in inputs (orchestrator format)
  let index_html = body.index_html || body.inputs?.index_html || body.inputs?.index_html_url;
  const callback = body.callback;
  const outputs = body.outputs;
  const artifact_paths = body.artifact_paths;

  if (!project_id) {
    return res.status(400).json({ error: "project_id required" });
  }

  // Finalize intentionally reuses the composition that just completed the
  // build step. The orchestrator only sends upload URLs for this follow-up
  // job, so recover the latest staged build HTML from the project mapping.
  // This also works after a worker restart because rehydrateJobs restores the
  // project → job index from the persistent volume.
  if (!index_html && step === "finalize") {
    const previousJobId = projectJobs.get(project_id);
    const previousJob = previousJobId ? jobs.get(previousJobId) : null;
    const previousHtml = previousJob?.job_dir ? join(previousJob.job_dir, "index.html") : "";
    if (previousHtml && existsSync(previousHtml)) {
      index_html = readFileSync(previousHtml, "utf-8");
      console.log(`[worker] finalize reused staged build composition for project ${project_id}`);
    }
  }

  if (!index_html) {
    return res.status(400).json({ error: "index_html or inputs.index_html required" });
  }

  // V4-debug3: LLM may return JSON wrapper {title, duration, html} instead of
  // raw HTML. Extract the html field if so.
  if (typeof index_html === 'string' && index_html.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(index_html);
      if (parsed.html) {
        index_html = parsed.html;
      }
    } catch {
      // Not valid JSON — use as-is (it's HTML)
    }
  }

  const jobId = body.job_id || randomUUID();
  const jobDir = join(WORK_DIR, jobId);
  mkdirSync(join(jobDir, "assets"), { recursive: true });

  // Post-process generated HTML before it enters the offline render pipeline.
  // The CLI launches Chromium inside this container, so public CDN references
  // are both unnecessary and a source of fatal ERR_BLOCKED_BY_ORB failures.
  if (typeof index_html === 'string') {
    // V4-3f.17 (Fase 5): mechanical tween sanitization BEFORE lint — the
    // worker's last line of defense against the gsap_non_transform_motion
    // error class (left/top tweens) that hard-failed the V4-3f.16 build.
    // Mirrors the edge-side repair; every conversion is logged.
    const tweenFix = sanitizeCompositionTweens(index_html);
    if (tweenFix.repairs.length > 0) {
      console.warn(
        `[worker] sanitized ${tweenFix.repairs.length} layout-prop tween(s) before lint: ${tweenFix.repairs.join("; ")}`
      );
      index_html = tweenFix.html;
    }
    // V4-3f.10: resolve Google Fonts into local woff2 assets BEFORE the
    // sanitizer strips the references — lint's font_family_without_font_face
    // rule needs an @font-face declaration for every brand family.
    let fontFaceStyle = "";
    try {
      const fonts = await prepareOfflineFonts(index_html, {
        jobDir,
        cacheDir: join(WORK_DIR, "__vp-font-cache"),
        log: console.log,
      });
      fontFaceStyle = fonts.style;
    } catch (err) {
      console.warn(`[worker] font preparation failed: ${err?.message ?? err}`);
    }
    index_html = sanitizeCompositionForOffline(index_html, {
      gsapRuntime: runtimeBundles.gsap,
      fontFaceStyle,
    });
  }

  let jobMediaValidation = null;

  // V4-3f.12: pre-stage external videos/audio locally. The HyperFrames CLI
  // downloads remote URLs itself, but if the URL returns an HTML page, a 403,
  // or a truncated response, ffprobe fails with "moov atom not found". We
  // fetch + validate + rewrite here so the error is surfaced early and the
  // render pipeline only sees valid local MP4 files.
  if (typeof index_html === "string") {
    const mediaResult = await prestageExternalMedia(index_html, jobDir, {
      fetchImpl: fetch,
      ffprobePath: "ffprobe",
      timeoutMs: 60_000,
      log: console.log,
    });
    if (!mediaResult.ok) {
      const summary = mediaResult.failures
        .map((f) => `${f.url} -> ${f.reason}: ${f.detail}`)
        .join("; ");
      const error = new Error(`MEDIA_VALIDATION_FAILED: ${summary}`);
      jobs.set(jobId, {
        id: jobId,
        project_id,
        step: step || "render",
        status: "failed",
        created_at: new Date().toISOString(),
        job_dir: jobDir,
        callback,
        outputs,
        artifact_paths,
        error: formatExecError(error),
        media_validation: { urls_found: mediaResult.failures.length, urls_failed: mediaResult.failures },
      });
      writeJobMarker(jobDir, {
        job_id: jobId,
        project_id,
        step: step || "render",
        mode: body.mode === "preview" ? "preview" : "render",
        created_at: new Date().toISOString(),
      });
      return res.status(422).json({
        job_id: jobId,
        status: "failed",
        error: "MEDIA_VALIDATION_FAILED",
        failures: mediaResult.failures,
      });
    }
    if (!mediaResult.skipped) {
      console.log(`[worker] pre-staged ${mediaResult.downloaded.length} external media file(s)`);
      index_html = mediaResult.html;
    }
    // Persist validation metadata for diagnostics in callbacks.
    jobMediaValidation = {
      urls_found: mediaResult.downloaded.length,
      urls_downloaded: mediaResult.downloaded,
    };
  }

  // Write the composition HTML
  writeFileSync(join(jobDir, "index.html"), index_html);

  // V5-P0C §2.1 + V5_16.2 B1: quantize rounding drift onto the fps grid before
  // consumers run, but preserve a builder-declared gap across the whole root
  // composition. Timeline intent is never silently collapsed.
  let windowLintFindings = [];
  let windowNormalizationWarning = null;
  if (typeof index_html === "string") {
    try {
      const stagingFps = Number.isFinite(Number(body.fps)) && Number(body.fps) > 0 ? Number(body.fps) : 30;
      const norm = normalizeClipWindows(index_html, stagingFps);
      if (norm.warning) {
        windowNormalizationWarning = norm.warning;
        console.warn(
          `CLIP_WINDOWS_NON_CONTIGUOUS previous=${norm.warning.previous_id ?? "?"} next=${norm.warning.next_id ?? "?"} declared_start=${norm.warning.declared_start} expected_start=${norm.warning.expected_start}`
        );
      } else if (norm.adjusted.length > 0) {
        console.log(
          `[worker] window normalization: ${norm.adjusted.length} clip window(s) quantized to the ${stagingFps}fps grid`
        );
        index_html = norm.html;
        writeFileSync(join(jobDir, "index.html"), index_html);
      }
      windowLintFindings = lintClipWindows(index_html, { fps: stagingFps });
      if (windowLintFindings.length > 0) {
        console.warn(
          `[worker] clip window lint: ${windowLintFindings.map((f) => `[${f.code}] ${f.selector ?? ""}`).join(", ")}`
        );
      }
    } catch (err) {
      console.warn(`[worker] window normalization skipped: ${err?.message ?? err}`);
    }
  }

  const uploadErrors = {};
  const directUploadFailure = (channel) => (message) =>
    recordUploadFailure(uploadErrors, channel, message);
  if (step !== "preview" && ORCHESTRATOR_PROJECT_ID_RE.test(project_id) && !supabase) {
    recordUploadFailure(uploadErrors, "composition_html", supabaseConfig.error);
    recordUploadFailure(uploadErrors, "composition_elements", supabaseConfig.error);
  }

  // V4_04 fix: persistir a composição staged no storage — o editor usa
  // `projects/{id}/compositions/index.html` como fonte primária pós-build
  // (reconciliação de durações) e como alvo das edições. Fire-and-forget no
  // staging; a promessa fica no job para o callback reportar o resultado.
  // step:'preview' é o placeholder inicial — não pode competir com o HTML real.
  const compositionUploadPromise = step !== "preview"
    ? persistCompositionArtifact(
      supabase,
      project_id,
      index_html,
      console.log,
      directUploadFailure("composition_html"),
    )
    : null;

  // V5-P3A (AD-5): derivar e publicar o registry de elementos ao lado da
  // composição — index_html aqui já é o HTML FINAL (pós-sanitize/normalize),
  // logo o inventário reflete exatamente o que o preview serve. Mesmo
  // fire-and-forget; o resultado viaja no callback (composition_elements).
  const elementsUploadPromise = step !== "preview"
    ? persistElementsArtifact(
      supabase,
      project_id,
      deriveElements(index_html),
      console.log,
      directUploadFailure("composition_elements"),
    )
    : null;

  // V4-3g.3 (B6): marcador para reidratação do registry no boot.
  writeJobMarker(jobDir, {
    job_id: jobId,
    project_id,
    step: step || "render",
    mode: body.mode === "preview" ? "preview" : "render",
    created_at: new Date().toISOString(),
  });

  // Write assets if provided
  if (body.assets) {
    for (const [name, data] of Object.entries(body.assets)) {
      const buf = Buffer.from(data, "base64");
      const assetPath = join(jobDir, "assets", name);
      mkdirSync(dirname(assetPath), { recursive: true });
      writeFileSync(assetPath, buf);
    }
  }
  if (runtimeBundles.gsap) {
    writeFileSync(join(jobDir, VENDORED_GSAP_ASSET_PATH), runtimeBundles.gsap);
  }

  jobs.set(jobId, {
    id: jobId,
    project_id,
    step: step || "render",
    status: "queued",
    created_at: new Date().toISOString(),
    job_dir: jobDir,
    callback,
    outputs,
    artifact_paths,
    media_validation: jobMediaValidation,
    window_lint_findings: windowLintFindings,
    window_normalization_warning: windowNormalizationWarning,
    upload_errors: uploadErrors,
    compositionUploadPromise,
    elementsUploadPromise,
  });
  // Track by project_id for preview lookup
  projectJobs.set(project_id, jobId);

  // mode:'preview' stages the composition only (no HyperFrames CLI run) —
  // used for editor previews and contract tests (V4-3f.3).
  if (body.mode !== "preview") {
    // Run render asynchronously
    runRender(jobId, jobDir).catch((err) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.error = formatExecError(err);
      }
    });
  } else {
    jobs.get(jobId).status = "staged";
  }

  res.json({ job_id: jobId, status: "queued" });
});

// ── Poll status ─────────────────────────────────────────────────────
app.get("/job/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

// ── V5.14 F7: supervisão da pipeline ──────────────────────────────
// Auth: mesmo padrão das rotas de escrita server-to-server (WORKER_SECRET, que
// é o VIDEO_V4_CALLBACK_SECRET do orquestrador). O /supervise não tem segredos
// próprios: o contrato (rotas da edge + secret) chega no corpo, porque o worker
// é burro também na configuração.
function authorizedWorkerService(req) {
  if (!WORKER_SECRET) return { ok: false, status: 503, error: "auth_not_configured" };
  if ((req.get("x-worker-secret") || "") !== WORKER_SECRET) return { ok: false, status: 401, error: "invalid_secret" };
  return { ok: true };
}

app.post("/supervise", (req, res) => {
  const auth = authorizedWorkerService(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const projectId = req.body?.project_id;
  if (!projectId) return res.status(400).json({ error: "project_id required" });
  const out = superviseProject(projectId, req.body);
  // 400 só por contrato inválido: um corpo sem URLs/secret não pode arrancar
  // um loop cego (e o orquestrador fica com a pista no log do pedido).
  if (out.status) return res.status(out.status).json({ error: out.reason });
  res.status(202).json(out);
});

app.get("/supervision", (req, res) => {
  const auth = authorizedWorkerService(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.json({ projects: supervision.list(), tick_ms: SUPERVISOR_TICK_MS, enabled: supervisorEnabled(process.env) });
});

// ── V4-04C: project-scoped write endpoints (patch / restructure) ────
// Auth: server-to-server secret (X-Worker-Secret === WORKER_SECRET) or the
// same preview HMAC token as GET /preview/:id. Without either secret the
// routes refuse to open (503) — the preview is never publicly writable.
function authorizeProjectWrite(req, projectId) {
  const hasService = Boolean(WORKER_SECRET);
  const hasPreview = Boolean(PREVIEW_SECRET);
  if (!hasService && !hasPreview) {
    return { ok: false, status: 503, error: "auth_not_configured" };
  }
  if (hasService && (req.get("x-worker-secret") || "") === WORKER_SECRET) {
    return { ok: true };
  }
  if (hasPreview) {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (verifyPreviewToken(token, projectId, PREVIEW_SECRET)) return { ok: true };
    return { ok: false, status: 401, error: "invalid_token" };
  }
  return { ok: false, status: 401, error: "invalid_secret" };
}

/** Resolve a job by project_id (orchestrator format) or internal job_id. */
function resolveJobById(id) {
  const internalJobId = projectJobs.get(id);
  if (internalJobId) {
    const job = jobs.get(internalJobId);
    if (job) return job;
  }
  return jobs.get(id) ?? null;
}

app.options("/patch/:id", previewCors);
app.post("/patch/:id", previewCors, (req, res) => {
  const projectId = req.params.id;
  const auth = authorizeProjectWrite(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const job = resolveJobById(projectId);
  if (!job) return res.status(404).json({ error: "not found" });

  const { patches } = req.body ?? {};
  if (!Array.isArray(patches) || patches.length === 0) {
    return res.status(400).json({ error: "patches must be a non-empty array" });
  }
  for (const p of patches) {
    if (!p || typeof p.selector !== "string" || typeof p.property !== "string" || typeof p.value !== "string") {
      return res.status(400).json({ error: "each patch must have {selector, property, value} strings" });
    }
  }

  const indexPath = join(job.job_dir, "index.html");
  if (!existsSync(indexPath)) return res.status(404).json({ error: "index.html not found" });
  const html = readFileSync(indexPath, "utf-8");

  let result;
  try {
    result = applyPatchesLinkedom(html, patches);
  } catch (err) {
    const status = err?.status ?? 500;
    return res.status(status).json({ error: err?.message ?? "patch failed" });
  }

  writeFileSync(indexPath, result.html);
  console.log(`[worker] /patch ${projectId}: ${result.applied}/${patches.length} patch(es) applied`);
  // V4-04C §2.1: the PATCHED HTML rides on the response — the caller
  // (Vercel route) persists it to Supabase storage; the worker stays
  // Supabase-free.
  // V5-P1E: `created` lista ids criados por operações de nó (duplicate).
  // V5-P3A: `elements` é o registry derivado do HTML FINAL — o caller
  // publica-o como projects/{id}/compositions/elements.json na mesma escrita.
  res.json({
    ok: true,
    applied: result.applied,
    created: result.created ?? [],
    html: result.html,
    elements: deriveElements(result.html),
  });
});

app.options("/restructure/:id", previewCors);
app.post("/restructure/:id", previewCors, (req, res) => {
  const projectId = req.params.id;
  const auth = authorizeProjectWrite(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const job = resolveJobById(projectId);
  if (!job) return res.status(404).json({ error: "not found" });

  const { scenes, fps, transitions, replace_scene_html } = req.body ?? {};
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: "scenes must be a non-empty array" });
  }
  for (const s of scenes) {
    if (!s || typeof s.id !== "string" || !Number.isFinite(Number(s.durationFrames))) {
      return res.status(400).json({ error: "each scene must have {id, durationFrames}" });
    }
  }
  // V5-P2C §2.4: optional boundary transitions keyed by incoming scene id.
  // Shape-validated here; kind/duration normalization happens in the engine.
  if (transitions !== undefined) {
    if (!Array.isArray(transitions)) {
      return res.status(400).json({ error: "transitions must be an array" });
    }
    for (const tr of transitions) {
      if (
        !tr ||
        typeof tr.id !== "string" ||
        typeof tr.kind !== "string" ||
        !Number.isFinite(Number(tr.durationMs))
      ) {
        return res
          .status(400)
          .json({ error: "each transition must have {id, kind, durationMs}" });
      }
    }
  }

  // V5-P4B (S19 §2.1): optional scene content replacement — shape validated
  // here; structural semantics (no scripts/.clip/roots, target must exist)
  // live in the engine.
  if (replace_scene_html !== undefined) {
    if (
      !replace_scene_html ||
      typeof replace_scene_html !== "object" ||
      Array.isArray(replace_scene_html) ||
      typeof replace_scene_html.id !== "string" ||
      typeof replace_scene_html.html !== "string"
    ) {
      return res
        .status(400)
        .json({ error: "replace_scene_html must be {id, html}" });
    }
  }

  const indexPath = join(job.job_dir, "index.html");
  if (!existsSync(indexPath)) return res.status(404).json({ error: "index.html not found" });
  const html = readFileSync(indexPath, "utf-8");

  let result;
  try {
    result = applyTimelineRestructure(html, scenes, fps ?? 30, transitions ?? [], replace_scene_html ?? null);
  } catch (err) {
    const status = err?.status ?? 500;
    return res.status(status).json({ error: err?.message ?? "restructure failed" });
  }

  // V5-P0C §2.2: validate the rewritten windows — the quantization above
  // guarantees a clean sequence, so any finding here is a real regression.
  const findings = lintClipWindows(result.html, { fps: fps ?? 30 });
  if (findings.length > 0) {
    console.warn(
      `[worker] /restructure ${projectId}: clip window findings: ${findings.map((f) => `[${f.code}] ${f.selector ?? ""}`).join(", ")}`
    );
  }

  writeFileSync(indexPath, result.html);
  console.log(
    `[worker] /restructure ${projectId}: ${result.applied} clip(s) rewritten, ${result.removed.length} removed`
  );
  // V5-P3A: registry coerente com o HTML reescrito (cenas removidas somem do
  // inventário; sceneId reflete as janelas novas).
  res.json({
    ok: true,
    applied: result.applied,
    removed: result.removed,
    replaced: result.replaced ?? null,
    html: result.html,
    findings,
    elements: deriveElements(result.html),
  });
});

// ── Serve preview ───────────────────────────────────────────────────
// V4-3f.7: CORS on preview routes so the Studio frontend can poll readiness
// (fetch GET before mounting the iframe) — avoids the initial 404 while the
// build job hasn't been staged. Exposure equals iframe embedding (the URL
// already carries an HMAC token).
function previewCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}
app.options("/preview/:id", previewCors);
app.options("/preview/:id/assets/:file", previewCors);
app.get("/preview/:id", previewCors, (req, res) => {
  // V4-3g.5 (R5): preview nunca público. Com PREVIEW_SECRET definido, o
  // token HMAC é obrigatório — 401 (NÃO 404) para o polling do Studio
  // distinguir "não autorizado" de "ainda não staged". Sem secret, mantém o
  // comportamento legacy (aviso no boot). O check corre ANTES do lookup para
  // não revelar a existência do projeto.
  if (PREVIEW_SECRET) {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyPreviewToken(token, req.params.id, PREVIEW_SECRET)) {
      return res.status(401).json({ error: "invalid_token" });
    }
  }

  // Lookup by project_id first (orchestrator format), then by job_id
  let job = null;
  const internalJobId = projectJobs.get(req.params.id);
  if (internalJobId) {
    job = jobs.get(internalJobId);
  }
  if (!job) {
    job = jobs.get(req.params.id);
  }
  if (!job) return res.status(404).json({ error: "not found" });

  const indexPath = join(job.job_dir, "index.html");
  if (!existsSync(indexPath)) {
    return res.status(404).json({ error: "index.html not found" });
  }

  // V4-3f.3 (A3): inject the click-to-edit helper script before serving so
  // the editor iframe can select elements and receive hot-swap patches.
  let html = readFileSync(indexPath, "utf-8");

  // V4_04A fix: boot the vendored HyperFrames runtime in previews. The
  // sanitizer strips runtime <script> tags from the staged HTML (the CLI
  // re-injects its own at render time) but mode:'preview' never runs the
  // CLI — without this, the hf-preview bridge never boots, `ready` never
  // reaches the editor and the "runtime did not respond" banner always
  // shows. Serve-time injection keeps the stored HTML lint/render-clean.
  if (runtimeBundles.hyperframes) {
    html = injectPreviewRuntime(html, `/preview/${req.params.id}/__vp_runtime.js`);
  }

  // V4-3f.9: inject <base> tag so relative asset URLs (e.g.
  // assets/__vp_gsap.min.js) resolve correctly regardless of whether the
  // preview URL carries a trailing slash. Without it, the browser resolves
  // "assets/foo.js" against /preview/ (the parent directory of /preview/<id>)
  // producing /preview/assets/foo.js instead of /preview/<id>/assets/foo.js.
  const baseTag = `<base href="/preview/${req.params.id}/">`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (match) => `${match}${baseTag}`);
  } else {
    html = baseTag + html;
  }

  res.type("html").send(injectPreviewHelper(html));
});

// Serve static assets from job dirs.
// V4-3f.9 follow-up: the preview URL carries the project_id (orchestrator
// format), so resolve the job exactly like GET /preview/:id — project_id
// first, then internal job_id. Previously only job_id was accepted, which
// 404'd every subresource (e.g. assets/__vp_gsap.min.js) because the
// `jobs` map is keyed by job_id, not project_id.
// NOTE: no HMAC token check here on purpose — browser subresources
// (<script>/<img> src) cannot carry the parent document's ?token= query.
// Exposure equals the vendored runtime + project media; the HTML itself
// (the attack surface that reveals composition content) stays token-gated.
app.get("/preview/:id/assets/:file", previewCors, (req, res) => {
  let job = null;
  const internalJobId = projectJobs.get(req.params.id);
  if (internalJobId) {
    job = jobs.get(internalJobId);
  }
  if (!job) {
    job = jobs.get(req.params.id);
  }
  if (!job) return res.status(404).json({ error: "not found" });

  // :file must be a plain file name — reject anything that could escape
  // the assets dir (e.g. encoded traversal segments).
  const file = basename(req.params.file);
  if (!file || file !== req.params.file) {
    return res.status(404).json({ error: "asset not found" });
  }

  const filePath = join(job.job_dir, "assets", file);
  if (existsSync(filePath)) {
    // Cross-platform: express.sendFile rejects Windows absolute paths in some
    // versions, so read the buffer and send it with inferred content-type.
    const ext = file.endsWith(".js") ? ".js" : file.slice(file.lastIndexOf("."));
    const type = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : undefined;
    const buf = readFileSync(filePath);
    return type ? res.type(type).send(buf) : res.send(buf);
  }

  // Jobs staged before the local-runtime rollout may lack the vendored
  // GSAP file on disk — serve the in-memory bundle so old previews work.
  if (file === basename(VENDORED_GSAP_ASSET_PATH) && runtimeBundles.gsap) {
    return res.type("application/javascript").send(runtimeBundles.gsap);
  }
  return res.status(404).json({ error: "asset not found" });
});

// ── V4_04A fix: vendored HyperFrames runtime for previews ───────────
// The staged composition has no runtime script (sanitizeCompositionForOffline
// strips it; the CLI only re-injects at render time) — see injectPreviewRuntime.
// This route serves the worker's own vendored bundle so previews can boot it
// and answer the editor's hf-preview handshake. Ungated like /assets: the
// bundle is public library code; the composition HTML stays token-gated.
app.get("/preview/:id/__vp_runtime.js", previewCors, (req, res) => {
  const bundle = runtimeBundles.hyperframes;
  if (!bundle) {
    return res
      .status(503)
      .type("text/plain")
      .send("// hyperframes runtime not vendored on this worker");
  }
  // Content-hash-free URL but stable bundle version → long cache is safe.
  return res
    .set("Cache-Control", "public, max-age=86400")
    .type("application/javascript")
    .send(bundle);
});

// ── V5-P2D: per-scene timeline thumbnails ───────────────────────────
// One CLI boot per artifact (sha1 of the served index.html): each ROOT scene
// window contributes one frame at its midpoint, captured with
// `hyperframes snapshot --at … --no-end --describe false -o thumbs/`.
// HMAC-gated like GET /preview/:id — the frames reveal composition content.
app.get("/preview/:id/thumbnails", previewCors, async (req, res) => {
  if (PREVIEW_SECRET) {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyPreviewToken(token, req.params.id, PREVIEW_SECRET)) {
      return res.status(401).json({ error: "invalid_token" });
    }
  }
  let job = null;
  const internalJobId = projectJobs.get(req.params.id);
  if (internalJobId) job = jobs.get(internalJobId);
  if (!job) job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const indexPath = join(job.job_dir, "index.html");
  if (!existsSync(indexPath)) return res.status(404).json({ error: "index.html not found" });
  const html = readFileSync(indexPath, "utf-8");

  try {
    const result = await captureThumbnails({
      jobDir: job.job_dir,
      html,
      env: { ...process.env, CHROME_PATH },
      run: (command, args, opts) =>
        spawnCommand(command, args, { timeout: 90000, ...opts }),
    });
    res.json({
      ok: true,
      artifact: computeArtifactHash(html),
      fps: result.fps,
      cached: result.cached,
      items: result.items.map((it) => ({
        time_s: it.time_s,
        file: it.file,
        url: `/preview/${req.params.id}/thumbs/${it.file}`,
      })),
    });
  } catch (err) {
    console.error(`[worker] /thumbnails ${req.params.id}: ${err.message}`);
    res.status(502).json({ error: "thumbnail capture failed", detail: String(err.message).slice(0, 400) });
  }
});

// Static PNG serving for the manifest items. Basename-guarded like
// /preview/:id/assets/:file; filenames embed their timestamp and are bound to
// a per-artifact manifest, so a long cache is safe.
app.get("/preview/:id/thumbs/:file", previewCors, (req, res) => {
  let job = null;
  const internalJobId = projectJobs.get(req.params.id);
  if (internalJobId) job = jobs.get(internalJobId);
  if (!job) job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const file = basename(req.params.file);
  if (!file || file !== req.params.file || !/^frame-\d+-at-.*\.png$/.test(file)) {
    return res.status(404).json({ error: "thumbnail not found" });
  }
  const filePath = join(job.job_dir, "thumbs", file);
  if (!existsSync(filePath)) return res.status(404).json({ error: "thumbnail not found" });
  return res
    .set("Cache-Control", "public, max-age=86400")
    .type("image/png")
    .send(readFileSync(filePath));
});

// ── Render pipeline ─────────────────────────────────────────────────
export async function runRender(jobId, jobDir) {
  const job = jobs.get(jobId);
  job.status = "running";
  job.started_at = new Date().toISOString();

  const startTime = Date.now();
  const timings = {};

  // V4-3f.12: isolate the HyperFrames extraction cache per job so a corrupted
  // cache entry from a previous render can never be reused.
  const extractCacheDir = join(jobDir, "__extract-cache");
  mkdirSync(extractCacheDir, { recursive: true });
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = extractCacheDir;

  try {
    // Step 1: lint
    timings.lint_start = Date.now();
    try {
      execSync(
        `npx hyperframes lint --json "${jobDir}"`,
        { encoding: "utf-8", timeout: 30000, env: { ...process.env, CHROME_PATH } }
      );
    } catch (lintErr) {
      // V4-3f.17 (Fase 5): parse the --json findings so the job error and
      // the orchestrator callback carry the full structured list instead of
      // a truncated opaque message. Warnings are tolerated; errors never.
      const findings = extractLintFindings(lintErr);
      if (findings && findings.length > 0) {
        const errors = findings.filter((f) => (f.severity ?? "error") !== "warning");
        if (errors.length === 0) {
          console.warn(
            `[worker] lint exited non-zero with warnings only — tolerating: ${findings.map((f) => f.code).join(", ")}`
          );
        } else {
          job.lint_findings = findings;
          const summary = errors
            .map((f) => `[${f.code}]${f.selector ? ` ${f.selector}` : ""}: ${f.message ?? ""}`)
            .join(" | ");
          const rich = new Error(`HYPERFRAMES_LINT_FAILED: ${summary}`);
          rich.stdout = lintErr.stdout;
          rich.stderr = lintErr.stderr;
          throw rich;
        }
      } else {
        throw lintErr;
      }
    }
    timings.lint_ms = Date.now() - timings.lint_start;

    // Step 2: check
    timings.check_start = Date.now();
    await runCheck(jobDir);
    timings.check_ms = Date.now() - timings.check_start;

    // Step 3: snapshot
    timings.snapshot_start = Date.now();
    try {
      const snapCmd = process.env.HYPERFRAMES_BIN || "npx";
      const snapArgs = process.env.HYPERFRAMES_BIN
        ? ["snapshot", "--frames", "5", jobDir]
        : ["hyperframes", "snapshot", "--frames", "5", jobDir];
      await spawnCommand(snapCmd, snapArgs, {
        timeout: 60000,
        env: { ...process.env, CHROME_PATH, PRODUCER_LOW_MEMORY_MODE: "true" },
      });
    } catch (snapErr) {
      console.warn(`[worker] snapshot generation warning: ${snapErr?.message ?? snapErr}`);
    }
    timings.snapshot_ms = Date.now() - timings.snapshot_start;

    // Step 4: render
    timings.render_start = Date.now();
    const _payloadOpts = (job.payload && typeof job.payload.options === 'object' && job.payload.options) ? job.payload.options : {};
    const _rawFmt = typeof _payloadOpts.format === 'string' ? _payloadOpts.format : 'mp4';
    const _validFmts = new Set(['mp4', 'webm', 'gif', 'png']);
    const exportFormat = _validFmts.has(_rawFmt) ? _rawFmt : 'mp4';
    const outputName = exportFormat === 'png' ? 'frame.png' : `output.${exportFormat}`;
    const outputPath = join(jobDir, "renders", outputName);
    mkdirSync(join(jobDir, "renders"), { recursive: true });
    // V4-3f.11: spawn (not execSync) so full stdout/stderr survive a
    // non-zero exit, with a timeout above the CLI's own protocolTimeout.
    // R3 (V4_01_INFRA §4 / docker-compose): VPS RAM ≤ 4GB — pin a single
    // capture worker + low-memory profile; "auto" spawns multiple Chrome
    // instances that OOM the box mid-capture.
    let renderResult;
    if (exportFormat === 'png') {
      const pngAt = typeof _payloadOpts.pngAtSeconds === 'number' && Number.isFinite(_payloadOpts.pngAtSeconds) ? _payloadOpts.pngAtSeconds : 1.5;
      const pngCommand = process.env.HYPERFRAMES_BIN || "npx";
      const pngArgs = process.env.HYPERFRAMES_BIN
        ? ["snapshot", "--at", String(pngAt), "--no-end", "-o", outputPath, jobDir]
        : ["hyperframes", "snapshot", "--at", String(pngAt), "--no-end", "-o", outputPath, jobDir];
      renderResult = await spawnCommand(pngCommand, pngArgs, {
        timeout: 600000,
        env: { ...process.env, CHROME_PATH, PRODUCER_LOW_MEMORY_MODE: "true" },
      });
    } else {
      const renderCommand = process.env.HYPERFRAMES_BIN || "npx";
      const fmtArgs = exportFormat !== 'mp4' ? ["--format", exportFormat] : [];
      const renderArgs = process.env.HYPERFRAMES_BIN
        ? ["render", "--quality", "high", "--workers", "1", ...fmtArgs, "-o", outputPath, jobDir]
        : ["hyperframes", "render", "--quality", "high", "--workers", "1", ...fmtArgs, "-o", outputPath, jobDir];
      renderResult = await spawnCommand(renderCommand, renderArgs, {
        timeout: 600000,
        env: { ...process.env, CHROME_PATH, PRODUCER_LOW_MEMORY_MODE: "true" },
      });
      if (exportFormat === 'gif' && renderResult.code === 0) {
        try {
          const gifSeconds = typeof _payloadOpts.gifSeconds === 'number' && Number.isFinite(_payloadOpts.gifSeconds) ? _payloadOpts.gifSeconds : 8;
          const { spawn } = await import('node:child_process');
          const gifTrim = await new Promise((resolve) => {
            const ff = spawn('ffmpeg', ['-y', '-t', String(gifSeconds), '-i', outputPath, '-c', 'copy', outputPath + '.tmp'], { stdio: 'pipe' });
            let resolved = false;
            ff.on('close', (c) => { if (!resolved) { resolved = true; resolve(c); } });
            ff.on('error', () => { if (!resolved) { resolved = true; resolve(1); } });
          });
          if (gifTrim === 0) {
            try { const { renameSync } = await import('node:fs'); renameSync(outputPath + '.tmp', outputPath); } catch {}
          }
        } catch {}
      }
    }
    // Persist the full CLI output on the (now persistent) volume for
    // post-mortem; keep only the tail in the in-memory job error.
    try {
      writeFileSync(
        join(jobDir, "render.log"),
        `exit=${renderResult.code} timedOut=${renderResult.timedOut}\n--- stdout ---\n${renderResult.stdout}\n--- stderr ---\n${renderResult.stderr}`
      );
    } catch (logErr) {
      console.warn(`[worker] failed to persist render.log: ${logErr.message}`);
    }
    if (renderResult.timedOut || renderResult.code !== 0) {
      const actionName = exportFormat === 'png' ? 'snapshot' : 'render';
      const error = new Error(
        `Command failed: npx hyperframes ${actionName} (exit ${renderResult.code}${renderResult.timedOut ? ", worker timeout 600s" : ""})`
      );
      error.stdout = renderResult.stdout;
      error.stderr = renderResult.stderr;
      throw error;
    }
    timings.render_ms = Date.now() - timings.render_start;

    // Collect results
    const snapshots = existsSync(join(jobDir, "snapshots")) ? readdirSync(join(jobDir, "snapshots")).filter((f) => f.endsWith(".png")) : [];
    const mp4Size = existsSync(outputPath) ? readFileSync(outputPath).length : 0;

    job.timings = timings;
    job.output = {
      mp4_path: outputPath,
      mp4_size_bytes: mp4Size,
      snapshots,
    };

    // Upload through the signed URL from the orchestrator. This keeps the
    // worker independent of Supabase credentials; the direct client remains
    // a backwards-compatible fallback for older deployments.
    const uploaded = {};
    const uploadErrors = job.upload_errors || {};
    const signedMp4Url = typeof job.outputs?.mp4_upload_url === "string"
      ? job.outputs.mp4_upload_url
      : "";
    const contentTypeMap = { mp4: "video/mp4", webm: "video/webm", gif: "image/gif", png: "image/png" };
    const uploadContentType = contentTypeMap[exportFormat] ?? "video/mp4";
    const uploadStorageKey = `projects/${job.project_id}/renders/${outputName}`;
    if (signedMp4Url) {
      await uploadToSignedUrl(signedMp4Url, readFileSync(outputPath), uploadContentType);
      job.output.mp4_url = uploadStorageKey;
      uploaded.mp4 = true;
    } else if (supabase) {
      const mp4Buf = readFileSync(outputPath);
      const { error } = await supabase.storage
        .from("video-artifacts")
        .upload(uploadStorageKey, mp4Buf, {
          contentType: uploadContentType,
          upsert: true,
        });
      if (error) job.upload_error = error.message;
      else {
        job.output.mp4_url = uploadStorageKey;
        uploaded.mp4 = true;
      }
    } else {
      throw new Error("no MP4 upload target configured");
    }

    // V4_04 fix: o staging fez upsert da composição no storage — esperar pela
    // promessa (resolvida em ms face ao render) para reportar ao orquestrador,
    // que registra o artifact nos steps do manifesto.
    await awaitStagedUploads(job, uploaded);

    // V5-P6A: snapshots do render final publicados para o quality gate
    // (projects/{id}/snapshots/frame-N.png, upsert). Nunca fatal — falha
    // apenas deixa o gate responder NO_SNAPSHOTS (retryable).
    if (supabase) {
      try {
        const published = await persistRenderSnapshots(
          supabase,
          job.project_id,
          jobDir,
          console.log,
          (message) => recordUploadFailure(uploadErrors, "snapshots", message),
        );
        uploaded.snapshots = published > 0;
      } catch (snapErr) {
        recordUploadFailure(uploadErrors, "snapshots", snapErr);
        uploaded.snapshots = false;
      }
    } else {
      uploaded.snapshots = false;
      recordUploadFailure(uploadErrors, "snapshots", supabaseConfig.error);
    }
    job.uploaded = uploaded;
    job.upload_errors = uploadErrors;
    job.status = "done";
    job.completed_at = new Date().toISOString();
    job.total_ms = Date.now() - startTime;

    // Callback to orchestrator (V4-1 contract)
    if (job.callback?.url) {
      try {
        await fetch(job.callback.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Worker-Secret": job.callback.secret || "",
          },
          body: JSON.stringify(buildDoneCallbackPayload(job, timings, uploaded, uploadErrors)),
        });
        console.log(`[callback] sent done for job ${job.id}`);
      } catch (cbErr) {
        console.error(`[callback] failed: ${cbErr.message}`);
      }
    }
  } catch (err) {
    // Composition/elements start during staging. Wait for both before the
    // terminal status/callback so their failures cannot arrive too late for
    // observability on a render that failed early.
    await awaitStagedUploads(job);
    job.status = "failed";
    job.error = formatExecError(err);
    job.total_ms = Date.now() - startTime;
    // Full-tail echo to container logs (Coolify) for post-mortem.
    console.error(`[worker] job ${jobId} (${job?.project_id ?? "?"}) failed:\n${job.error.slice(-2000)}`);

    // Callback to orchestrator on failure
    if (job.callback?.url) {
      try {
        await fetch(job.callback.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Worker-Secret": job.callback.secret || "",
          },
          body: JSON.stringify({
            job_id: job.id,
            project_id: job.project_id,
            step: job.step,
            status: "failed",
            error: job.error,
            total_ms: job.total_ms,
            media_validation: job.media_validation || null,
            // V4-3f.17 (Fase 5): full structured lint findings (when the
            // failure was a lint error) so the orchestrator/UI can surface
            // actionable detail instead of a truncated message.
            lint_findings: job.lint_findings || null,
            ...(Object.keys(job.upload_errors || {}).length > 0
              ? { upload_errors: job.upload_errors }
              : {}),
            ...(job.window_normalization_warning
              ? { window_normalization_warning: job.window_normalization_warning }
              : {}),
          }),
        });
        console.log(`[callback] sent failed for job ${job.id}`);
      } catch (cbErr) {
        console.error(`[callback] failed: ${cbErr.message}`);
      }
    }
  }
}

// ─ Start ───────────────────────────────────────────────────────────
// Only listen when executed directly (`node server.js`); when imported by
// tests the app is exported without binding a port.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HyperFrames worker listening on :${PORT}`);
    console.log(`Chrome: ${CHROME_PATH}`);
    console.log(`Work dir: ${WORK_DIR}`);
    console.log(`Supabase: ${supabase ? "connected" : "not configured"}`);
    if (PREVIEW_SECRET) {
      console.log("Preview token: enforced (HMAC-SHA256)");
    } else {
      console.warn("[worker] PREVIEW_SECRET not set — GET /preview/:id is UNAUTHENTICATED (R5)");
    }
  });
}

export { app, injectPreviewHelper };
