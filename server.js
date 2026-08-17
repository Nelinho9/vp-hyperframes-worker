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

const app = express();
app.use(express.json({ limit: "200mb" }));

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8787;
const WORK_DIR = process.env.WORK_DIR || "/tmp/hyperframes-worker";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ─ In-memory job store (prototype; use DB in production) ───────────
const jobs = new Map();
// Map project_id → job_id for preview lookup
const projectJobs = new Map();

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

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), chrome: CHROME_PATH });
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

  // Post-process: fix incorrect HyperFrames runtime CDN URLs
  const CORRECT_RUNTIME = "https://cdn.jsdelivr.net/npm/@heygen/hyperframes@0.7.109/dist/hyperframes.min.js";
  if (typeof index_html === 'string') {
    // Replace common wrong CDN URLs with the correct one
    index_html = index_html
      .replace(/https?:\/\/cdn\.hyperframes\.io\/[^"'\s]*/g, CORRECT_RUNTIME)
      .replace(/https?:\/\/unpkg\.com\/[^"'\s]*hyperframes[^"'\s]*/g, CORRECT_RUNTIME)
      .replace(/https?:\/\/cdn\.jsdelivr\.net\/npm\/hyperframes[^"'\s]*/g, CORRECT_RUNTIME);
    // If no runtime script tag at all, inject one before </head>
    if (!index_html.includes('hyperframes') && index_html.includes('</head>')) {
      index_html = index_html.replace('</head>', `<script src="${CORRECT_RUNTIME}"></script>\n</head>`);
    }
  }

  // Write the composition HTML
  writeFileSync(join(jobDir, "index.html"), index_html);

  // Write assets if provided
  if (body.assets) {
    for (const [name, data] of Object.entries(body.assets)) {
      const buf = Buffer.from(data, "base64");
      const assetPath = join(jobDir, "assets", name);
      mkdirSync(dirname(assetPath), { recursive: true });
      writeFileSync(assetPath, buf);
    }
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
async function runRender(jobId, jobDir) {
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
    execSync(
      `npx hyperframes check --json "${jobDir}"`,
      { encoding: "utf-8", timeout: 60000, env: { ...process.env, CHROME_PATH } }
    );
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
  });
}

export { app, injectPreviewHelper };
