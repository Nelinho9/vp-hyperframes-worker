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
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "fs";
import { join, basename, dirname } from "path";
import { fetchBounded } from "./bounded-fetch.js";
import { parseRenderJob, publicJob, confinedPath, secureEqual } from "./job-contract.js";
import { createJobQueue, atomicWriteJob } from "./job-queue.js";
import { jobEnvironment } from "./job-environment.js";
import { pathToFileURL, fileURLToPath } from "url";
import { injectPreviewHelper, injectPreviewRuntime, injectSourceIdentity, resolveServedSourceIdentity } from "./preview-helper.js";
import { verifyPreviewToken } from "./preview-token.js";
import { applyPatchesLinkedom, applyTimelineRestructure, normalizeClipWindows } from "./patch-engine.js";
import { sanitizeCompositionTweens, sanitizeTimelineRegistry, extractLintFindings } from "./composition-sanitizer.js";
import { lintClipWindows, lintGsapTargets } from "./window-lint.js";
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
import { captureThumbnails, computeArtifactHash, parseScenePostEntranceTimes, buildRenderSnapshotArgs, renderSnapshotsLegacyFrames } from "./thumbnails.js";
import { deriveElements, persistElementsArtifact } from "./elements-registry.js";
import { randomUUID } from "node:crypto";
import { createCompositionEditor, compositionPreviewOptions, registerCompositionRoutes } from "./composition-editor.js";
import { persistRenderSnapshots } from "./snapshots-upload.js";
import { resolveWorkerRenderOptions, persistEffectiveOptions } from "./render-options.js";
import { buildExportArgv as buildF04ExportArgv, buildLintArgv as buildF04LintArgv, buildCheckArgv as buildF04CheckArgv } from "./render-argv.js";
import { validateFfprobeOutput as validateF04Bytes, isPngSignature, isMp4Signature } from "./render-verify.js";
import { validateTemporalAudioPlan, parseRootWindows, parseRootDuration } from "./render-temporal.js";
import { buildEvidenceManifest, buildCoverageSchedule, evidenceSnapshotPath, CLI_VERSION as F04_CLI_VERSION } from "./render-evidence.js";
import {
  createSupervisionRegistry,
  normalizeDriver,
  startSupervision,
  supervisorEnabled,
} from "./pipeline-runner.js";

const app = express();
app.use('/job', (req, res, next) => {
  const auth = authorizedWorkerService(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const timer = setTimeout(() => req.destroy(), 30_000);
  req.once('end', () => clearTimeout(timer));
  req.once('close', () => clearTimeout(timer));
  next();
});
app.use(express.json({ limit: "48mb" }));
app.use((error, _req, res, _next) => {
  res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'INVALID_REQUEST_BODY' });
});

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
// Inbound server-to-server auth: Edge VIDEO_V4_WORKER_SECRET.
// Callback transport and boot supervisor use distinct credentials.
// Missing inbound configuration always fails closed.
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
  // F04-T11: callback usa job/project/step/revision que correspondem ao job aceito;
  // duplicate/out-of-order não troca artefacto de outra revisão. Reconcile usa o
  // mesmo resultado público redigido, nunca wire privado.
  const payload = {
    job_id: job.id,
    project_id: job.project_id,
    step: job.step, request_id: job.request_id, revision: job.composition_revision ?? job.revision, input_hash: job.input_hash, callback_nonce: job.callback?.nonce,
    status: "done",
    timings,
    uploaded,
    total_ms: job.total_ms,
    // F04-T11: revisões correlacionadas + effective options + output medido.
    contract_revision: job.contract_revision ?? 1,
    composition_revision: job.composition_revision ?? job.revision,
    composition_hash: job.composition_hash ?? null,
    effective_config_revision: job.effective_config_revision ?? null,
    effective_config_hash: job.effective_config_hash ?? null,
    ...(job.measured_output ? { measured_output: job.measured_output } : {}),
    ...(job.evidence_manifest ? { evidence: { status: job.evidence_manifest.status, revision: job.evidence_manifest.revision } } : {}),
  };
  if (Object.keys(uploadErrors).length > 0) payload.upload_errors = uploadErrors;
  if (job.window_normalization_warning) {
    payload.window_normalization_warning = job.window_normalization_warning;
  }
  return payload;
}

/**
 * V5_32 Fase C (C2 — D2): entrega do callback ao orquestrador com leitura de
 * `res.ok`, retry com backoff curto e estado visível em `job.callback_status`
 * (exposto no `/job/:id/status`). Antes o `await fetch(...)` era cego: um 400 da
 * edge (ex.: schema do callback) passava por enviado, o job ficava `dispatched`
 * e a UI mostrava loading eterno até ao teto do watchdog.
 */
export async function postCallback(url, secret, payload, options = {}) {
  const {
    fetchImpl = fetch,
    attempts = 3,
    baseDelayMs = 500,
    log = console,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const label = payload?.status ?? "?";
  let last = { ok: false, attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response: res } = await fetchBounded(url, { fetchImpl, timeoutMs: 15_000, maxBytes: 16_384, consumeBody: false, init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Secret": secret || "",
        },
        body: JSON.stringify(payload),
      } });
      if (res.ok) {
        return { ok: true, status: res.status, attempts: attempt, at: new Date().toISOString() };
      }
      const bodyText = "";
      last = {
        ok: false,
        status: res.status,
        attempts: attempt,
        error: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
        at: new Date().toISOString(),
      };
      log.error(
        `[callback] ${label} rejected by orchestrator (attempt ${attempt}/${attempts}): HTTP ${res.status}${bodyText ? ` ${bodyText.slice(0, 500)}` : ""}`
      );
    } catch (err) {
      last = {
        ok: false,
        attempts: attempt,
        error: /^HTTP_\d+$|^DOWNLOAD_[A-Z_]+$/.test(err?.message || "") ? err.message : "CALLBACK_TRANSPORT_FAILED",
        at: new Date().toISOString(),
      };
      log.error(`[callback] ${label} transport error (attempt ${attempt}/${attempts}): ${last.error}`);
    }
    if (attempt < attempts) await sleep(baseDelayMs * attempt);
  }
  log.error(`[callback] giving up after ${attempts} attempt(s): ${last.error}`);
  return last;
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
 *   orquestrador); `null` ⇒ deriva de SUPABASE_URL + SUPERVISOR_SECRET (boot).
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
  // F04-T11: reidratação não transforma done/failed em staged. Quando existe
  // job-state-v1.json durável (jobQueue), ele é a fonte (preserva terminal
  // status/options/result/evidence); o marker job.json só cobre legacy/preview.
  found.sort((a, b) => String(a.marker.created_at ?? "").localeCompare(String(b.marker.created_at ?? "")));
  for (const { marker, jobDir } of found) {
    if (jobs.has(marker.job_id)) continue;
    let durable = null;
    try {
      const statePath = join(jobDir, "job-state-v1.json");
      if (existsSync(statePath)) durable = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch { durable = null; }
    if (durable && (durable.status === "done" || durable.status === "failed")) {
      durable.job_dir = jobDir;
      jobs.set(marker.job_id, durable);
    } else {
      jobs.set(marker.job_id, {
        id: marker.job_id,
        project_id: marker.project_id,
        step: marker.step || "render",
        status: "staged",
        created_at: marker.created_at || new Date().toISOString(),
        job_dir: jobDir,
      });
    }
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
const jobQueue = createJobQueue({ root: WORK_DIR, jobs, processJob: stageJob, deliverCallback: retryTerminalCallback,
  concurrency: process.env.JOB_CONCURRENCY, capacity: process.env.JOB_QUEUE_CAPACITY });
jobQueue.recover();
for (const job of [...jobs.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) projectJobs.set(job.project_id, job.id);
async function retryTerminalCallback(job) {
  if (!job.callback?.url || job.callback_status?.ok) return;
  job.callback_payload ||= { job_id: job.id, project_id: job.project_id, request_id: job.request_id, step: job.step,
    revision: job.revision, input_hash: job.input_hash, callback_nonce: job.callback.nonce,
    status: job.status, ...(job.status === 'failed' ? { error: job.error_code || 'WORKER_JOB_FAILED' } : {}) };
  atomicWriteJob(job);
  job.callback_status = await postCallback(job.callback.url, job.callback.secret, job.callback_payload);
}

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
    .map((b) => (b ? b.toString().replace(/https?:\/\/[^\s"'<>]+/g, "[remote-resource]") : ""))
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
  const { response } = await fetchBounded(url, { timeoutMs: 60_000, consumeBody: false, init: {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  } });
  if (!response.ok) {
    throw new Error(`signed upload failed (${response.status})`);
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
      child.kill("SIGKILL");
    }, timeout);

    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1024 * 1024); });
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

export function formatCheckFailure(classified) {
  const findingText = classified.fatal
    .map((finding) => `${finding.code ?? "runtime_error"}: ${finding.message ?? "unknown error"}`)
    .join("\n");
  return `HyperFrames check failed (CLI ${classified.version})\n${findingText || "unknown check failure"}`;
}

export async function runCheck(jobDir, env = { ...process.env, CHROME_PATH }) {
  const command = process.env.HYPERFRAMES_BIN || "npx";
  const args = process.env.HYPERFRAMES_BIN
    ? ["check", "--json", jobDir]
    : ["hyperframes", "check", "--json", jobDir];
  const result = await spawnCommand(command, args, {
    timeout: 60000,
    env,
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
    const error = new Error(formatCheckFailure(classified));
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.code = result.code;
    throw error;
  }
  if (classified.unknown.length) {
    const codes = classified.unknown.map((finding) => finding.code ?? "unknown").join(",");
    console.warn(`[worker] hyperframes check returned ok=false without a known failure (CLI ${classified.version}; ${codes}); continuing with structured warning`);
  }
  if (classified.warnings.length || result.code !== 0) {
    console.warn(`[worker] hyperframes check continued with ${classified.warnings.length} warning(s) (CLI ${classified.version})`);
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
    active_jobs: jobQueue.stats().active,
    queue: jobQueue.stats(),
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
async function stageJob(body, { publishPreview = true, resolvePublished = true } = {}) {
  const project_id = body.project_id;
  const step = body.step;
  // E01: a published head supersedes mutable aliases and stale job inputs.
  // Activation already read/verified its source and stages in isolation.
  const publication = resolvePublished && ORCHESTRATOR_PROJECT_ID_RE.test(project_id)
    ? await compositionEditor.readJobComposition(project_id, body)
    : null;
  // F04-T02/T03: options efetivas tipadas, guardadas no job durável F01 e
  // recuperadas no restart. Staging usa a mesma effective fps que render.
  // Alias N-1 só pelo adapter definido; unknown/invalid nunca viram defaults silenciosos.
  const resolvedOptions = resolveWorkerRenderOptions(body);
  if (resolvedOptions.ok === false) {
    const detail = resolvedOptions.failures.map((f) => `[${f.code}] expected=${f.expected} observed=${f.observed}`).join(" | ");
    throw new Error(`F04_EFFECTIVE_OPTIONS_INVALID: ${detail}`);
  }
  const effectiveFps = resolvedOptions.options.fps;
  const effectiveFormat = resolvedOptions.options.format;
  // F04-T03: inline-vs-ref como union discriminada; refs só pelo transporte
  // autenticado/bounded F01. Nunca passar string URL ao parser como se fosse HTML.
  // Inline: body.index_html ou inputs.index_html (string HTML). Ref: inputs.index_html_url (https).
  // Fixture legacy: inputs.fixture com proveniência explícita.
  const inlineHtml = publication?.html || (typeof body.index_html === "string" && body.index_html.length > 0
    ? body.index_html
    : (body.inputs && typeof body.inputs.index_html === "string" && body.inputs.index_html.length > 0 ? body.inputs.index_html : ""));
  const refUrl = body.inputs && typeof body.inputs.index_html_url === "string" && body.inputs.index_html_url.length > 0
    ? body.inputs.index_html_url : "";
  const fixtureName = body.inputs && typeof body.inputs.fixture === "string" ? body.inputs.fixture : "";
  let compositionProvenance = body.options_provenance === "legacy-fallback" ? "legacy-fallback" : "fresh";
  // F04-T03: recusar expected revision stale (producer já recusa; defesa em profundidade).
  if (typeof body.composition_revision === "number" && typeof body.revision === "number"
    && body.composition_revision !== body.revision) {
    throw new Error(`STALE_REVISION: expected composition_revision ${body.composition_revision}, observed revision ${body.revision}`);
  }
  let index_html = inlineHtml;
  let compositionSourceKind = inlineHtml ? "inline" : "";
  if (!index_html && refUrl) {
    // Ref: só https pelo transporte bounded; worker faz download explícito aqui.
    // (O pre-stage de media continua separado; isto é a fonte de composição.)
    let refOk = false;
    try { const u = new URL(refUrl); refOk = u.protocol === "https:"; } catch { refOk = false; }
    if (!refOk) throw new Error("INVALID_COMPOSITION_SOURCE");
    // Não confundir URL com HTML: descarregar pelo transporte bounded F01.
    try {
      const { response, body: refBody } = await fetchBounded(refUrl, { timeoutMs: 30_000, consumeBody: true, maxBytes: 8 * 1024 * 1024, init: {} });
      if (!response.ok) throw new Error(`ref fetch ${response.status}`);
      index_html = Buffer.from(refBody).toString("utf-8");
      compositionSourceKind = "ref";
    } catch (err) {
      throw new Error(`COMPOSITION_REF_FETCH_FAILED: ${err?.message ?? err}`);
    }
  }
  if (!index_html && fixtureName) {
    // Fallback legacy com proveniência explícita (fixture do worker, sem fingir composição fresca).
    compositionProvenance = "legacy-fallback";
    compositionSourceKind = "legacy-fixture";
  }
  const callback = body.callback;
  const outputs = body.outputs;
  const artifact_paths = body.artifact_paths;

  if (!project_id) {
    throw new Error("INVALID_PROJECT_ID");
  }

  // Finalize intentionally reuses the composition that just completed the
  // build step. The orchestrator only sends upload URLs for this follow-up
  // job, so recover the latest staged build HTML from the project mapping.
  // This also works after a worker restart because rehydrateJobs restores the
  // project → job index from the persistent volume.
  // V5.24: track the previous job dir — when the reused HTML already carries
  // worker-local `assets/vp-media-*` references (post-prestage), the new
  // jobDir starts empty and prestage skips (it only downloads https://).
  // Copying the previous job's assets/ heals the reuse instead of failing
  // lint with audio_src_not_found / missing_local_asset.
  let reusedPreviousJobDir = "";
  if (!index_html && step === "finalize") {
    const previousJobId = projectJobs.get(project_id);
    const previousJob = previousJobId ? jobs.get(previousJobId) : null;
    const previousHtml = previousJob?.job_dir ? join(previousJob.job_dir, "index.html") : "";
    if (previousHtml && existsSync(previousHtml)) {
      index_html = readFileSync(previousHtml, "utf-8");
      reusedPreviousJobDir = previousJob.job_dir;
      console.log(`[worker] finalize reused staged build composition for project ${project_id}`);
    }
  }

  if (!index_html) {
    throw new Error("HTML_REQUIRED");
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

  const jobId = body.job_id;
  const jobDir = confinedPath(WORK_DIR, jobId);
  mkdirSync(join(jobDir, "assets"), { recursive: true });

  // V5.24: heal worker-local asset reuse. `assets/vp-media-*` paths are only
  // valid inside the jobDir that prestaged them (sha1(url) → local file).
  // When the incoming HTML already carries such references — finalize reuse
  // above, or a re-dispatch of previously staged HTML persisted to storage —
  // prestage skips (it only downloads https://) and lint would fail with
  // audio_src_not_found / missing_local_asset. Copy the previous job's
  // assets/ for the same project so the new jobDir resolves them.
  try {
    let donorDir = reusedPreviousJobDir;
    if (!donorDir && typeof index_html === "string" && /src\s*=\s*["']assets\/vp-media-/i.test(index_html)) {
      const prevId = projectJobs.get(project_id);
      const prevJob = prevId ? jobs.get(prevId) : null;
      if (prevJob?.job_dir && prevJob.job_dir !== jobDir) donorDir = prevJob.job_dir;
    }
    if (donorDir) {
      const srcAssets = join(donorDir, "assets");
      const dstAssets = join(jobDir, "assets");
      if (existsSync(srcAssets)) {
        let copied = 0;
        for (const name of readdirSync(srcAssets)) {
          if (name === "__vp_gsap.min.js") continue;
          const src = join(srcAssets, name);
          const dst = join(dstAssets, name);
          if (!existsSync(dst)) {
            try {
              copyFileSync(src, dst);
              copied += 1;
            } catch {
              // best-effort — a missing file surfaces as lint error below
            }
          }
        }
        if (copied > 0) console.log(`[worker] copied ${copied} staged asset(s) from previous job for project ${project_id}`);
      }
    }
  } catch {
    // best-effort healing — never blocks staging
  }

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
    // V5.27 Fase D: timeline-registry repair BEFORE lint — the worker's last
    // line of defense against the gsap_timeline_not_registered error class
    // (job 1700b4f4) that hard-failed the build on the worker. Mirrors the
    // edge-side intra-script repair (Fase A); each insertion is logged like
    // the tween-fixes above. Runs on the exact bytes the CLI will see, so it
    // also covers re-dispatched Studio HTML and worker-materialized blocks
    // that never pass through the edge.
    try {
      const compositionId =
        index_html.match(/data-composition-id\s*=\s*["']([^"']+)["']/i)?.[1] ?? "main";
      const registryFix = sanitizeTimelineRegistry(index_html, compositionId);
      if (registryFix.repairs.length > 0) {
        console.warn(
          `[worker] registered ${registryFix.repairs.length} timeline(s) before lint: ${registryFix.repairs.join("; ")}`
        );
        index_html = registryFix.html;
      }
    } catch (err) {
      console.warn(`[worker] timeline registry repair skipped: ${err?.message ?? err}`);
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
  // Opção A (F12-voz): resultados do pré-stage por ficheiro (URLs mascaradas)
  // para a evidence — substitui os logs runtime invisíveis no Coolify.
  let jobMediaOutcomes = [];

  // V5.24: canonical HTML for storage/registry. prestage rewrites https://
  // srcs to job-local `assets/vp-media-*` paths (sha1(url) → jobDir/assets).
  // Persisting the rewritten HTML poisoned `compositions/index.html`: the
  // next job starts with an empty jobDir, prestage skips (only https:// is
  // downloaded) and lint fails with audio_src_not_found / missing_local_asset
  // for exactly those vp-media-* files. The canonical (pre-prestage,
  // post-sanitize) HTML keeps the original https:// URLs and stays valid
  // across jobs — disk keeps the rewritten form, storage keeps canonical.
  let canonicalHtml = index_html;

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
    if (Array.isArray(mediaResult.outcomes)) jobMediaOutcomes = mediaResult.outcomes;
    if (!mediaResult.ok) {
      const summary = mediaResult.failures
        .map((f) => `${f.reason}: ${f.detail}`)
        .join("; ");
      const error = new Error(`MEDIA_VALIDATION_FAILED: ${summary}`);
      jobs.set(jobId, {
    ...jobs.get(jobId),
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
      throw error;
    }
    if (!mediaResult.skipped) {
      console.log(`[worker] pre-staged ${mediaResult.downloaded.length} external media file(s)`);
      index_html = mediaResult.html;
    } else if (typeof index_html === "string" && /src\s*=\s*["']assets\/vp-media-/i.test(index_html)) {
      // V5.24: poisoned re-dispatch signature — HTML already carries job-local
      // `assets/vp-media-*` paths but prestage found no https:// to download.
      // Donor copy above heals the same-worker case; cross-worker/restart or
      // poisoned storage still lands here and lint will fail below. Log the
      // exact missing files so Coolify post-mortem points at the storage copy,
      // not at the CLI rule.
      const missing = [...index_html.matchAll(/src\s*=\s*["'](assets\/vp-media-[^"']+)["']/gi)]
        .map((mm) => mm[1])
        .filter((src, idx, arr) => arr.indexOf(src) === idx);
      console.warn(
        `[worker] pre-staged 0 files but HTML references ${missing.length} worker-local asset(s) (poisoned re-dispatch?): ${missing.slice(0, 8).join(", ")}`
      );
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
  // F04-T02/T05: staging usa a mesma effective fps que render (nunca body.fps solto).
  let windowLintFindings = [];
  let windowNormalizationWarning = null;
  if (typeof index_html === "string") {
    try {
      const stagingFps = effectiveFps;
      if (body?.fps !== undefined && Number(body.fps) !== effectiveFps) {
        console.warn(`[worker] body.fps ${body.fps} ignorado — staging usa effective fps ${effectiveFps}`);
      }
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
      // V5.21 Fase H: orphan-tween scan — report-only (warn log, never fails
      // staging; the edge-side mirror in edgeLint.ts surfaces it to the LLM).
      try {
        const gsapTargetFindings = lintGsapTargets(index_html);
        if (gsapTargetFindings.length > 0) {
          console.warn(
            `[worker] gsap target lint: ${gsapTargetFindings.map((f) => `[${f.code}] ${f.selector ?? ""}`).join(", ")}`
          );
        }
      } catch (err) {
        console.warn(`[worker] gsap target lint skipped: ${err?.message ?? err}`);
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
  // V5.24: persist canonicalHtml (pré-prestage) — o index_html reescrito contém
  // `assets/vp-media-*` válidos só dentro deste jobDir; gravá-lo no storage
  // envenenava o próximo job (prestage skipped → lint HYPERFRAMES_LINT_FAILED).
  const compositionUploadPromise = step !== "preview" && !publication
    ? persistCompositionArtifact(
      supabase,
      project_id,
      canonicalHtml,
      console.log,
      directUploadFailure("composition_html"),
    )
    : null;

  // V5-P3A (AD-5): derivar e publicar o registry de elementos ao lado da
  // composição — canonicalHtml aqui é o HTML CANÓNICO (pós-sanitize,
  // pré-prestage, com URLs https:// originais), logo o inventário reflete o
  // que o editor deve editar. O preview serve o HTML reescrito por jobDir.
  // Mesmo fire-and-forget; o resultado viaja no callback (composition_elements).
  const elementsUploadPromise = step !== "preview" && !publication
    ? persistElementsArtifact(
      supabase,
      project_id,
      deriveElements(canonicalHtml),
      console.log,
      directUploadFailure("composition_elements"),
    )
    : null;

  // V4-3g.3 (B6): marcador para reidratação do registry no boot.
  // Isolated activation candidates have no boot-visible marker until the
  // verified head is published locally with atomicWriteJob below.
  if (publishPreview) writeJobMarker(jobDir, {
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
      const assetPath = confinedPath(join(jobDir, "assets"), name);
      mkdirSync(dirname(assetPath), { recursive: true });
      writeFileSync(assetPath, buf);
    }
  }
  if (runtimeBundles.gsap) {
    writeFileSync(join(jobDir, VENDORED_GSAP_ASSET_PATH), runtimeBundles.gsap);
  }

  // F04-T05: validar root/windows e audio plan F03 antes do render.
  // Source durations reais vs slots sem truncar VO; sem word estimates como acústica.
  // N-1: HTML legacy sem scene-N (testes/preview antigos) segue com proveniência
  // legacy explícita em vez de falhar — producer novo envia root/windows e cai no ramo estrito.
  if (typeof index_html === "string" && body.mode !== "preview") {
    const rootDuration = parseRootDuration(index_html);
    const rootWindows = parseRootWindows(index_html).map((w) => ({ id: w.id, start: w.start, duration: w.duration }));
    if (rootWindows.length === 0) {
      console.warn(`[worker] F04 temporal: sem root windows (legacy, provenance=${compositionProvenance}); segue sem gate estrito`);
    } else {
    const audioSlots = Array.isArray(body.audio_plan?.slots) ? body.audio_plan.slots.map((s, i) => ({
      frameNumber: typeof s.frameNumber === "number" ? s.frameNumber : i + 1,
      measuredSec: typeof s.measuredSec === "number" ? s.measuredSec : (typeof s.measured_duration === "number" ? s.measured_duration : null),
      measurementSource: typeof s.measurementSource === "string" ? s.measurementSource : (typeof s.measurement_source === "string" ? s.measurement_source : null),
      windowStart: typeof s.windowStart === "number" ? s.windowStart : (typeof s.window_start === "number" ? s.window_start : 0),
      windowEnd: typeof s.windowEnd === "number" ? s.windowEnd : (typeof s.window_end === "number" ? s.window_end : 0),
    })) : [];
    const temporal = validateTemporalAudioPlan({
        rootDuration, windows: rootWindows, audioSlots,
        transitionsMs: Array.isArray(body.transitions_ms) ? body.transitions_ms : [],
        fps: effectiveFps,
      });
      if (temporal.ok === false) {
        const detail = temporal.failures.map((f) => `[${f.code}] expected=${f.expected} observed=${f.observed}`).join(" | ");
        const error = new Error(`F04_TEMPORAL_AUDIO_INVALID: ${detail}`);
        jobs.set(jobId, {
          ...jobs.get(jobId),
          id: jobId, project_id, step: step || "render", status: "failed",
          created_at: new Date().toISOString(), job_dir: jobDir,
          callback, outputs, artifact_paths,
          error: formatExecError(error),
          effective_options: resolvedOptions.options,
          options_provenance: resolvedOptions.options.provenance,
          composition_source_kind: compositionSourceKind,
          composition_provenance: compositionProvenance,
        });
        writeJobMarker(jobDir, {
          job_id: jobId, project_id, step: step || "render",
          mode: body.mode === "preview" ? "preview" : "render",
          created_at: new Date().toISOString(),
        });
        throw error;
      }
    }
  }

  const baseRecord = jobs.get(jobId) ?? {};
  const withOptions = persistEffectiveOptions({ ...baseRecord }, resolvedOptions);
  jobs.set(jobId, {
    ...withOptions,
    id: jobId,
    project_id,
    step: step || "render",
    status: "queued",
    created_at: new Date().toISOString(),
    job_dir: jobDir,
    callback,
    outputs,
    artifact_paths,
    // F04-T11: lifecycle enriquecido (contract/config/composition/evidence revisions,
    // effective options, proveniência). Restart não transforma done/failed em staged.
    contract_revision: 1,
    composition_revision: resolvedOptions.options.composition_revision,
    composition_hash: resolvedOptions.options.composition_hash,
    effective_config_revision: resolvedOptions.options.effective_config_revision,
    effective_config_hash: resolvedOptions.options.effective_config_hash,
    composition_source_kind: compositionSourceKind,
    composition_provenance: compositionProvenance,
    media_validation: jobMediaValidation,
    media_prestage_outcomes: jobMediaOutcomes,
    window_lint_findings: windowLintFindings,
    window_normalization_warning: windowNormalizationWarning,
    upload_errors: uploadErrors,
    compositionUploadPromise,
    elementsUploadPromise,
  });
  // Track by project_id for preview lookup
  // Published projects change preview only through serialized activation;
  // a render that finishes staging late cannot replace a newer preview.
  if (publishPreview && !publication) projectJobs.set(project_id, jobId);

  // mode:'preview' stages the composition only (no HyperFrames CLI run) —
  // used for editor previews and contract tests (V4-3f.3).
  if (body.mode !== "preview") {
    await runRender(jobId, jobDir);
  } else {
    jobs.get(jobId).status = "staged";
  }
  return jobs.get(jobId);
}
app.post('/job', (req, res) => {
  try {
    const { body, hash } = parseRenderJob(req.body, WORKER_SECRET);
    const result = jobQueue.accept(body, hash);
    if (result.status === 409) return res.status(409).json({ error: 'JOB_HASH_CONFLICT' });
    if (result.status === 429) return res.status(429).json({ error: 'JOB_QUEUE_FULL' });
    if (result.status === 503) return res.status(503).json({ error: 'DURABLE_STORE_UNAVAILABLE' });
    return res.status(result.status).json({ job_id: result.job.id, status: result.job.status });
  } catch (error) {
    const code = error?.message || 'INVALID_JOB';
    return res.status(/^[A-Z_]+$/.test(code) ? 400 : 503).json({ error: /^[A-Z_]+$/.test(code) ? code : 'DURABLE_STORE_UNAVAILABLE' });
  }
});

// ── Poll status ─────────────────────────────────────────────────────
// Status is an internal reconciliation endpoint. Even authorized callers do
// not need callback secrets or signed upload URLs to identify a terminal job.
export function redactJobStatus(value) { return publicJob(value); }

app.get("/job/:id/status", (req, res) => {
  const auth = authorizedWorkerService(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(redactJobStatus(job));
});

// ── V5.14 F7: supervisão da pipeline ──────────────────────────────
// Inbound /supervise auth uses WORKER_SECRET. Its private driver credential
// targets the orchestrator independently; boot uses SUPERVISOR_SECRET.
function authorizedWorkerService(req) {
  if (!WORKER_SECRET) return { ok: false, status: 503, error: "auth_not_configured" };
  if (!secureEqual(req.get("x-worker-secret") || "", WORKER_SECRET)) return { ok: false, status: 401, error: "invalid_secret" };
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

// E01 endpoints prepare canonical candidates without touching a live preview.
// Old mutation routes below remain N-1 compatibility only and are blocked for
// projects with a published head; all new consumers use prepare + DB publisher.
export const compositionEditor = createCompositionEditor({
  // The same configured store used by readText below; never request authority.
  storageUrl: SUPABASE_URL,
  async readHead(projectId) {
    // A worker with no database configuration can only serve N-1 jobs.
    // Activation still refuses without an authoritative published head.
    if (!supabase) return null;
    const { data, error } = await supabase.from('video_composition_heads')
      .select('project_id,revision,composition').eq('project_id', projectId).maybeSingle();
    if (error) throw Object.assign(new Error('COMPOSITION_HEAD_READ_FAILED'), { code: 'COMPOSITION_HEAD_READ_FAILED', status: 503 });
    return data;
  },
  async readText(path) {
    if (!supabase) throw Object.assign(new Error('COMPOSITION_STORAGE_UNAVAILABLE'), { code: 'COMPOSITION_STORAGE_UNAVAILABLE', status: 503 });
    const { data, error } = await supabase.storage.from('video-artifacts').download(path);
    if (error || !data) throw Object.assign(new Error('COMPOSITION_SOURCE_READ_FAILED'), { code: 'COMPOSITION_SOURCE_READ_FAILED', status: 503 });
    return data.text();
  },
  current(projectId) {
    const job = resolveJobById(projectId);
    return Number.isSafeInteger(job?.publication_revision)
      ? { revision: job.publication_revision, content_hash: job.publication_content_hash }
      : null;
  },
  async stage(projectId, html, head) {
    const options = compositionPreviewOptions(html, head);
    return stageJob({
      job_id: randomUUID(), project_id: projectId, step: 'preview', mode: 'preview',
      revision: head.revision, composition_revision: head.revision,
      composition_hash: options.composition_hash, index_html: html,
      options, outputs: {}, artifact_paths: {},
    }, { publishPreview: false, resolvePublished: false });
  },
  async publish(projectId, candidate, head) {
    candidate.publication_revision = head.revision;
    candidate.publication_content_hash = head.content_hash;
    // Durable identity before swapping the project pointer. Failed staging or
    // failed disk persistence never replaces the previous preview.
    atomicWriteJob(candidate);
    projectJobs.set(projectId, candidate.id);
  },
});
registerCompositionRoutes(app, compositionEditor, authorizedWorkerService);

async function requireLegacyComposition(projectId, res) {
  try {
    if (ORCHESTRATOR_PROJECT_ID_RE.test(projectId) && await compositionEditor.readPublished(projectId)) {
      res.status(409).json({ error: 'COMPOSITION_PREPARE_REQUIRED' });
      return false;
    }
    return true;
  } catch (error) {
    res.status(error.status ?? 503).json({ error: error.code ?? 'COMPOSITION_HEAD_READ_FAILED' });
    return false;
  }
}

app.options("/patch/:id", previewCors);
app.post("/patch/:id", previewCors, async (req, res) => {
  const projectId = req.params.id;
  const auth = authorizeProjectWrite(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (!await requireLegacyComposition(projectId, res)) return;

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
app.post("/restructure/:id", previewCors, async (req, res) => {
  const projectId = req.params.id;
  const auth = authorizeProjectWrite(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (!await requireLegacyComposition(projectId, res)) return;

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
  // V5.21 Fase H: orphan-tween scan — report-only (warn log; the response
  // `findings` contract stays clip-windows-only).
  try {
    const gsapTargets = lintGsapTargets(result.html);
    if (gsapTargets.length > 0) {
      console.warn(
        `[worker] /restructure ${projectId}: gsap target findings: ${gsapTargets.map((f) => `[${f.code}] ${f.selector ?? ""}`).join(", ")}`
      );
    }
  } catch (err) {
    console.warn(`[worker] /restructure ${projectId}: gsap target lint skipped: ${err?.message ?? err}`);
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
app.get("/preview/:id", previewCors, async (req, res) => {
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

  try {
    if (ORCHESTRATOR_PROJECT_ID_RE.test(req.params.id)) await compositionEditor.ensurePreview(req.params.id);
  } catch (error) {
    return res.status(error.status ?? 503).json({ error: error.code ?? 'COMPOSITION_PREVIEW_SYNC_FAILED', preview_sync_pending: true });
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

  // E01-B C2 R09: attest WHICH canonical source this preview was staged from.
  // Publication activation candidates carry (publication_revision,
  // publication_content_hash) durably; legacy job previews stay identity-less —
  // the editor correlates fail-closed.
  const sourceIdentity = resolveServedSourceIdentity(job);
  if (sourceIdentity) html = injectSourceIdentity(html, sourceIdentity);

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
  try {
    if (ORCHESTRATOR_PROJECT_ID_RE.test(req.params.id)) await compositionEditor.ensurePreview(req.params.id);
  } catch (error) {
    return res.status(error.status ?? 503).json({ error: error.code ?? 'COMPOSITION_PREVIEW_SYNC_FAILED', preview_sync_pending: true });
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
  const jobEnv = jobEnvironment(jobDir, { ...process.env, CHROME_PATH });
  atomicWriteJob(job);

  try {
    // Step 1: lint (F04-T06: argv não-shell via builder dedicado).
    timings.lint_start = Date.now();
    try {
      const { command, args } = buildF04LintArgv(jobDir);
      const result = await spawnCommand(command, args, { timeout: 30_000, env: jobEnv });
      if (result.code !== 0 || result.timedOut) throw Object.assign(new Error('HyperFrames lint failed'), result);
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
    await runCheck(jobDir, jobEnv);
    timings.check_ms = Date.now() - timings.check_start;

    // Step 3: snapshot — F04-T09: schedule determinístico de TODAS as root
    // scene windows + boundaries/transições + CTA final (teste >5 cenas).
    // Substitui o corte primeiros-5: pós-entrada + boundary + final-cta por
    // cena, com clamping frame-exato para cenas curtas e nested ignorados
    // (só root entra — contrato). Orçamento documentado via maxSamples;
    // excedente vira skipped explícito, nunca cobertura integral fingida.
    // Rollback: RENDER_SNAPSHOTS_LEGACY_FRAMES=1 restaura --frames 5.
    timings.snapshot_start = Date.now();
    let coverageSchedule = { samples: [], skipped: [], missing: [] };
    try {
      let snapCmd = process.env.HYPERFRAMES_BIN || "npx";
      let snapArgs = process.env.HYPERFRAMES_BIN
        ? ["snapshot", "--frames", "5", jobDir]
        : ["hyperframes", "snapshot", "--frames", "5", jobDir];
      try {
        const snapIndexPath = join(jobDir, "index.html");
        if (!renderSnapshotsLegacyFrames() && existsSync(snapIndexPath)) {
          const snapHtml = readFileSync(snapIndexPath, "utf-8");
          const { parseSceneWindows } = await import("./thumbnails.js");
          const wins = parseSceneWindows(snapHtml).map((w, i) => ({ id: `scene-${i + 1}`, start: w.start, end: w.end }));
          if (wins.length > 0) {
            const effFpsForSnap = job.effective_options?.fps ?? 30;
            coverageSchedule = buildCoverageSchedule({ windows: wins, fps: effFpsForSnap, maxSamples: 24 });
            const times = coverageSchedule.samples.map((s) => s.time_s);
            if (times.length > 0) {
              ({ command: snapCmd, args: snapArgs } = buildRenderSnapshotArgs(times, jobDir));
            }
            if (coverageSchedule.skipped.length > 0) {
              console.warn(`[worker] coverage budget: ${coverageSchedule.skipped.length} sample(s) skipped (${coverageSchedule.skipped.map((s) => s.id).join(",")})`);
            }
          } else {
            const times = parseScenePostEntranceTimes(snapHtml);
            if (times.length > 0) {
              ({ command: snapCmd, args: snapArgs } = buildRenderSnapshotArgs(times, jobDir));
            }
          }
        }
      } catch (snapPrepErr) {
        console.warn(`[worker] post-entrance snapshot prep failed, using legacy --frames 5: ${snapPrepErr?.message ?? snapPrepErr}`);
      }
      await spawnCommand(snapCmd, snapArgs, {
        timeout: 60000,
        env: { ...jobEnv, PRODUCER_LOW_MEMORY_MODE: "true" },
      });
    } catch (snapErr) {
      console.warn(`[worker] snapshot generation warning: ${snapErr?.message ?? snapErr}`);
    }
    timings.snapshot_ms = Date.now() - timings.snapshot_start;

    // Step 4: render (F04-T06: argv não-shell via builder dedicado; F04-T02: usa
    // effective_options persistidas, nunca body.fps solto nem fallback MP4).
    timings.render_start = Date.now();
    const _effOpts = job.effective_options && typeof job.effective_options === "object" ? job.effective_options : null;
    const _payloadOpts = (job.payload && typeof job.payload.options === 'object' && job.payload.options) ? job.payload.options : {};
    const _rawFmt = typeof _effOpts?.format === 'string' ? _effOpts.format : (typeof _payloadOpts.format === 'string' ? _payloadOpts.format : 'mp4');
    const _validFmts = new Set(['mp4', 'webm', 'gif', 'png']);
    if (!_validFmts.has(_rawFmt)) {
      throw new Error(`F04_UNSUPPORTED_FORMAT: expected=format em [mp4,webm,gif,png] observed=${String(_rawFmt)}`);
    }
    const exportFormat = _rawFmt;
    const _effFps = typeof _effOpts?.fps === "number" ? _effOpts.fps : 30;
    const _effDur = typeof _effOpts?.duration_target_seconds === "number" ? _effOpts.duration_target_seconds : (typeof _payloadOpts.duration_target_seconds === "number" ? _payloadOpts.duration_target_seconds : 15);
    const exportBuilt = buildF04ExportArgv({
      format: exportFormat, jobDir,
      fps: _effFps,
      pngAtSeconds: _payloadOpts.pngAtSeconds ?? _effOpts?.pngAtSeconds,
      gifSeconds: _payloadOpts.gifSeconds,
      durationTargetSeconds: _effDur,
    });
    if (exportBuilt.ok === false) {
      throw new Error(`${exportBuilt.code}: expected=${exportBuilt.expected} observed=${exportBuilt.observed}`);
    }
    const outputName = exportBuilt.outputName;
    const outputPath = join(jobDir, "renders", outputName);
    mkdirSync(join(jobDir, "renders"), { recursive: true });
    // V4-3f.11: spawn (not execSync) so full stdout/stderr survive a
    // non-zero exit, with a timeout above the CLI's own protocolTimeout.
    // R3 (V4_01_INFRA §4 / docker-compose): VPS RAM ≤ 4GB — pin a single
    // capture worker + low-memory profile; "auto" spawns multiple Chrome
    // instances that OOM the box mid-capture.
    let renderResult;
    if (exportFormat === 'png') {
      renderResult = await spawnCommand(exportBuilt.command, exportBuilt.args, {
        timeout: exportBuilt.deadlineMs,
        env: { ...jobEnv, PRODUCER_LOW_MEMORY_MODE: "true" },
      });
    } else {
      renderResult = await spawnCommand(exportBuilt.command, exportBuilt.args, {
        timeout: exportBuilt.deadlineMs,
        env: { ...jobEnv, PRODUCER_LOW_MEMORY_MODE: "true" },
      });
      if (exportFormat === 'gif' && renderResult.code === 0) {
        // F04-T06: GIF aplica target duration com formato explícito, deadline e erro visível.
        const gifSeconds = typeof _payloadOpts.gifSeconds === 'number' && Number.isFinite(_payloadOpts.gifSeconds) ? _payloadOpts.gifSeconds : 8;
        const { spawn } = await import('node:child_process');
        const gifTrim = await new Promise((resolve) => {
          const ff = spawn('ffmpeg', ['-y', '-t', String(gifSeconds), '-i', outputPath, '-c', 'copy', outputPath + '.tmp'], { stdio: 'pipe' });
          let stderr = "";
          ff.stderr?.on("data", (c) => { stderr += c.toString(); });
          let resolved = false;
          ff.on('close', (c) => { if (!resolved) { resolved = true; resolve({ code: c, stderr }); } });
          ff.on('error', (e) => { if (!resolved) { resolved = true; resolve({ code: 1, stderr: String(e?.message ?? e) }); } });
          setTimeout(() => { if (!resolved) { resolved = true; try { ff.kill("SIGKILL"); } catch {} resolve({ code: 124, stderr: "ffmpeg deadline" }); } }, 120_000);
        });
        if (gifTrim.code === 0) {
          try { const { renameSync } = await import('node:fs'); renameSync(outputPath + '.tmp', outputPath); } catch (renameErr) {
            throw new Error(`F04_GIF_TRIM_FAILED: rename falhou: ${renameErr?.message ?? renameErr}`);
          }
        } else {
          throw new Error(`F04_GIF_TRIM_FAILED: ffmpeg exit ${gifTrim.code} ${String(gifTrim.stderr).slice(-500)}`);
        }
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

    // F04-T07: verificar bytes antes de upload/DONE (ffprobe + signature/MIME).
    // Divergência falha com expected/observed + diagnóstico sanitizado.
    {
      const { createHash } = await import("node:crypto");
      const outBytes = existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0);
      const outHash = outBytes.length > 0 ? createHash("sha256").update(outBytes).digest("hex") : "";
      let ffprobeJson = { format: {}, streams: [] };
      try {
        const ff = await spawnCommand("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", outputPath], { timeout: 30_000, env: jobEnv });
        const raw = (ff.stdout || "").trim() || "{}";
        ffprobeJson = JSON.parse(raw);
      } catch (ffErr) {
        // PNG pode não ter streams ffprobe úteis em fixtures mínimas; GIF idem.
        // Para mp4/webm a ausência de ffprobe é falha explícita.
        if (exportFormat === "mp4" || exportFormat === "webm") {
          throw new Error(`F04_FFPROBE_FAILED: expected=ffprobe válido para ${exportFormat} observed=${String(ffErr?.message ?? ffErr).slice(0, 200)}`);
        }
      }
      // Signature rápida por formato (defesa em profundidade além do ffprobe).
      if (exportFormat === "png" && outBytes.length > 0 && !isPngSignature(outBytes)) {
        throw new Error("F04_SIGNATURE_MISMATCH: expected=PNG signature observed=bytes não-PNG");
      }
      if (exportFormat === "mp4" && outBytes.length > 0 && !isMp4Signature(outBytes)) {
        console.warn("[worker] mp4 signature atípica (ftyp ausente no offset 4) — ffprobe decide");
      }
      const effForVerify = {
        width: _effOpts?.width ?? 1920, height: _effOpts?.height ?? 1080,
        fps: _effFps, duration_target_seconds: _effDur, format: exportFormat,
        mode: "deterministic",
      };
      const verified = validateF04Bytes({
        ffprobeJson,
        mime: exportBuilt.mime,
        fileSizeBytes: outBytes.length,
        expected: effForVerify,
      });
      if (verified.ok === false) {
        const detail = verified.failures.map((f) => `[${f.code}] expected=${f.expected} observed=${f.observed}`).join(" | ");
        try {
          writeFileSync(join(jobDir, "byte-verify-failure.json"), JSON.stringify({ expected: effForVerify, failures: verified.failures, mime: exportBuilt.mime, size: outBytes.length, hash: outHash }, null, 2));
        } catch {}
        throw new Error(`F04_BYTE_VERIFY_FAILED: ${detail}`);
      }
      job.measured_output = {
        format: exportFormat, mime: exportBuilt.mime,
        width: effForVerify.width, height: effForVerify.height, fps: effForVerify.fps,
        duration_target_seconds: effForVerify.duration_target_seconds,
        size_bytes: outBytes.length, sha256: outHash,
      };
    }

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
    // F04-T08: publicar evidence set por execução (namespace job/revision +
    // index/manifest com source, render job, composition hash, CLI version,
    // timestamp, scene/boundary IDs, paths/hashes/status). Publicação atómica;
    // parcial declara missing sem promover set antigo. Artefact paths e
    // MIME/output name coincidem com signed target e callback.
    {
      const { createHash } = await import("node:crypto");
      const { readdirSync: rd, readFileSync: rf, writeFileSync: wf, existsSync: ex } = await import("node:fs");
      const snapDir = join(jobDir, "snapshots");
      let snapFiles = [];
      try { snapFiles = ex(snapDir) ? rd(snapDir).filter((f) => f.toLowerCase().endsWith(".png")).sort() : []; } catch { snapFiles = []; }
      const snapEntries = snapFiles.slice(0, 24).map((file, i) => {
        let hash = "";
        try { hash = createHash("sha256").update(rf(join(snapDir, file))).digest("hex"); } catch { hash = ""; }
        const cov = coverageSchedule.samples[i];
        return { file, scene_id: cov?.scene_id ?? null, time_s: cov?.time_s ?? 0, sha256: hash };
      });
      const sceneIds = [...new Set(coverageSchedule.samples.map((s) => s.scene_id))];
      const manifest = buildEvidenceManifest({
        jobId: job.id, projectId: job.project_id, step: job.step,
        revision: job.composition_revision ?? job.revision,
        inputHash: job.input_hash ?? "",
        compositionHash: job.composition_hash ?? "",
        effectiveConfigRevision: job.effective_config_revision ?? 0,
        effectiveConfigHash: job.effective_config_hash ?? "",
        sceneIds,
        boundaryIds: coverageSchedule.samples.filter((s) => s.kind === "boundary").map((s) => s.scene_id),
        outputs: job.measured_output ? [{
          name: outputName,
          path: `projects/${job.project_id}/renders/${outputName}`,
          mime: exportBuilt.mime,
          size_bytes: job.measured_output.size_bytes,
          sha256: job.measured_output.sha256,
          width: job.measured_output.width, height: job.measured_output.height,
          fps: job.measured_output.fps, duration_sec: job.measured_output.duration_target_seconds,
        }] : [],
        snapshots: snapEntries.map((s) => ({ ...s, path: evidenceSnapshotPath({ projectId: job.project_id, jobId: job.id, revision: job.composition_revision ?? job.revision, file: s.file }) })),
        coverage: {
          total_windows: coverageSchedule.samples.length,
          sampled: snapEntries.length,
          skipped: coverageSchedule.skipped,
          missing: snapEntries.length === 0 ? ["no-snapshots-captured"] : [],
        },
        mediaPrestage: { outcomes: job.media_prestage_outcomes ?? [] },
      });
      try {
        const tmp = join(jobDir, "evidence-manifest.json.tmp");
        const fin = join(jobDir, "evidence-manifest.json");
        wf(tmp, JSON.stringify(manifest, null, 2));
        const { renameSync } = await import("node:fs");
        renameSync(tmp, fin);
      } catch (evErr) {
        console.warn(`[worker] evidence manifest persist failed: ${evErr?.message ?? evErr}`);
      }
      job.evidence_manifest = manifest;
      job.evidence_status = manifest.status;
    }
    job.uploaded = uploaded;
    job.upload_errors = uploadErrors;
    job.status = "done";
    job.completed_at = new Date().toISOString();
    job.total_ms = Date.now() - startTime;

    // Callback to orchestrator (V4-1 contract)
    // V5_32 C2: entrega com res.ok + retry; o desfecho fica em
    // `job.callback_status` (visível no /job/:id/status).
    if (job.callback?.url) {
      job.callback_payload = buildDoneCallbackPayload(job, timings, uploaded, uploadErrors);
      atomicWriteJob(job); await retryTerminalCallback(job);
      if (job.callback_status.ok) {
        console.log(`[callback] sent done for job ${job.id} (HTTP ${job.callback_status.status})`);
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
    // V5_32 C2: mesma entrega robusta do caminho `done` (res.ok + retry +
    // `callback_status`) — o 400 do schema que prendia o job deixa de ser mudo.
    if (job.callback?.url) {
      job.callback_payload = {
        job_id: job.id,
        project_id: job.project_id,
        step: job.step, request_id: job.request_id, revision: job.revision, input_hash: job.input_hash, callback_nonce: job.callback?.nonce,
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
      };
      atomicWriteJob(job); await retryTerminalCallback(job);
      if (job.callback_status.ok) {
        console.log(`[callback] sent failed for job ${job.id} (HTTP ${job.callback_status.status})`);
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
