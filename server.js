/**
 * VisttaPro HyperFrames Render Worker
 *
 * Receives render jobs via HTTP, runs the HyperFrames pipeline headless,
 * and uploads results to Supabase Storage. Designed for Coolify deployment.
 *
 * Endpoints:
 *   GET  /health                  — health check
 *   POST /job                     — submit a render job
 *   GET  /job/:id/status          — poll job status
 *   POST /job/:id/patch           — patch text in a frame (click-to-edit PoC)
 *   GET  /preview/:id             — serve hyperframes preview for a project
 */

import express from "express";
import { execSync, spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename, dirname } from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { injectPreviewHelper } from "./preview-helper.js";
import { verifyPreviewToken } from "./preview-token.js";
import {
  classifyCheckEnvelope,
  extractCheckJson,
  loadVendoredRuntimeBundles,
  sanitizeCompositionForOffline,
  VENDORED_GSAP_ASSET_PATH,
} from "./runtime-vendor.js";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8787;
const WORK_DIR = process.env.WORK_DIR || "/tmp/hyperframes-worker";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";
// V4-3g.5 (R5): quando definido, GET /preview/:id exige ?token= HMAC válido
// (mesmo segredo que VIDEO_V4_PREVIEW_SECRET no orchestrator edge).
const PREVIEW_SECRET = process.env.PREVIEW_SECRET || "";
const runtimeBundles = loadVendoredRuntimeBundles();

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

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
}

rehydrateJobs();

/**
 * V4-3f.7: execSync failures carry stdout/stderr Buffers on the error
 * object. Surface them in the job error so the orchestrator (and the
 * Studio UI) shows actionable lint findings instead of the opaque
 * "Command failed: npx hyperframes lint ..." message.
 */
export function formatExecError(err) {
  const base = err?.message ?? String(err);
  const detail = [err?.stderr, err?.stdout]
    .map((b) => (b ? b.toString() : ""))
    .filter((s) => s.trim())
    .join("\n")
    .trim();
  return detail ? `${base}\n${detail}`.slice(0, 4000) : base;
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

  // If no index_html yet (V4-2 mode before build step generates it), accept
  // the job but mark it as waiting for content.
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
    index_html = sanitizeCompositionForOffline(index_html, {
      gsapRuntime: runtimeBundles.gsap,
    });
  }

  // Write the composition HTML
  writeFileSync(join(jobDir, "index.html"), index_html);

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

// ── Patch text (click-to-edit PoC) ──────────────────────────────────
app.post("/job/:id/patch", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const { selector, text } = req.body;
  if (!selector || text === undefined) {
    return res.status(400).json({ error: "selector and text required" });
  }

  const indexPath = join(job.job_dir, "index.html");
  let html = readFileSync(indexPath, "utf-8");

  // Simple DOM patch: find element by id or class, replace textContent
  // In production, use a proper HTML parser (linkedom / jsdom)
  const idMatch = selector.startsWith("#");
  const target = idMatch ? selector.slice(1) : null;

  if (target) {
    // Replace text inside the element with this id
    const regex = new RegExp(
      `(<[^>]*id=["']${target}["'][^>]*>)([^<]*)(</)`,
      "g"
    );
    html = html.replace(regex, `$1${text}$3`);
    writeFileSync(indexPath, html);
    res.json({ ok: true, patched: selector, new_text: text });
  } else {
    res.status(400).json({ error: "only #id selectors supported in PoC" });
  }
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
  const html = readFileSync(indexPath, "utf-8");
  res.type("html").send(injectPreviewHelper(html));
});

// Serve static assets from job dirs
app.get("/preview/:id/assets/:file", previewCors, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const filePath = join(job.job_dir, "assets", req.params.file);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "asset not found" });
  }
  res.sendFile(filePath);
});

// ── Render pipeline ─────────────────────────────────────────────────
export async function runRender(jobId, jobDir) {
  const job = jobs.get(jobId);
  job.status = "running";
  job.started_at = new Date().toISOString();

  const startTime = Date.now();
  const timings = {};

  try {
    // Step 1: lint
    timings.lint_start = Date.now();
    execSync(
      `npx hyperframes lint --json "${jobDir}"`,
      { encoding: "utf-8", timeout: 30000, env: { ...process.env, CHROME_PATH } }
    );
    timings.lint_ms = Date.now() - timings.lint_start;

    // Step 2: check
    timings.check_start = Date.now();
    await runCheck(jobDir);
    timings.check_ms = Date.now() - timings.check_start;

    // Step 3: snapshot
    timings.snapshot_start = Date.now();
    execSync(
      `npx hyperframes snapshot --frames 5 "${jobDir}"`,
      { encoding: "utf-8", timeout: 60000, env: { ...process.env, CHROME_PATH } }
    );
    timings.snapshot_ms = Date.now() - timings.snapshot_start;

    // Step 4: render
    timings.render_start = Date.now();
    const outputPath = join(jobDir, "renders", "output.mp4");
    mkdirSync(join(jobDir, "renders"), { recursive: true });
    execSync(
      `npx hyperframes render --quality high -o "${outputPath}" "${jobDir}"`,
      { encoding: "utf-8", timeout: 300000, env: { ...process.env, CHROME_PATH } }
    );
    timings.render_ms = Date.now() - timings.render_start;

    // Collect results
    const snapshots = readdirSync(join(jobDir, "snapshots")).filter((f) => f.endsWith(".png"));
    const mp4Size = existsSync(outputPath) ? readFileSync(outputPath).length : 0;

    job.status = "done";
    job.completed_at = new Date().toISOString();
    job.total_ms = Date.now() - startTime;
    job.timings = timings;
    job.output = {
      mp4_path: outputPath,
      mp4_size_bytes: mp4Size,
      snapshots,
    };

    // Upload to Supabase (if configured)
    const uploaded = {};
    if (supabase) {
      const mp4Buf = readFileSync(outputPath);
      const { error } = await supabase.storage
        .from("video-artifacts")
        .upload(`projects/${job.project_id}/renders/output.mp4`, mp4Buf, {
          contentType: "video/mp4",
          upsert: true,
        });
      if (error) job.upload_error = error.message;
      else {
        job.output.mp4_url = `projects/${job.project_id}/renders/output.mp4`;
        uploaded.mp4 = true;
      }
    }

    // Callback to orchestrator (V4-1 contract)
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
            status: "done",
            timings,
            uploaded,
            total_ms: job.total_ms,
          }),
        });
        console.log(`[callback] sent done for job ${job.id}`);
      } catch (cbErr) {
        console.error(`[callback] failed: ${cbErr.message}`);
      }
    }
  } catch (err) {
    job.status = "failed";
    job.error = formatExecError(err);
    job.total_ms = Date.now() - startTime;

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
