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

  // Run render asynchronously
  runRender(jobId, jobDir).catch((err) => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = err.message;
    }
  });

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
app.get("/preview/:id", (req, res) => {
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

  // Serve the HTML with assets from the job dir
  res.sendFile(indexPath);
});

// Serve static assets from job dirs
app.get("/preview/:id/assets/:file", (req, res) => {
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
    if (supabase) {
      const mp4Buf = readFileSync(outputPath);
      const { error } = await supabase.storage
        .from("video-artifacts")
        .upload(`projects/${job.project_id}/renders/output.mp4`, mp4Buf, {
          contentType: "video/mp4",
          upsert: true,
        });
      if (error) job.upload_error = error.message;
      else job.output.mp4_url = `projects/${job.project_id}/renders/output.mp4`;
    }
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.total_ms = Date.now() - startTime;
  }
}

// ─ Start ───────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HyperFrames worker listening on :${PORT}`);
  console.log(`Chrome: ${CHROME_PATH}`);
  console.log(`Work dir: ${WORK_DIR}`);
  console.log(`Supabase: ${supabase ? "connected" : "not configured"}`);
});
