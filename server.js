/**
 * VisttaPro HyperFrames Render Worker — V4-1
 *
 * Worker BURRO (V4_01_INFRA §2): holds NO Supabase secrets. Receives signed
 * GET URLs for inputs, signed PUT URLs for outputs and calls back the
 * orchestrator edge with a shared secret.
 *
 * Endpoints:
 *   GET  /health             — health check (used by Docker/Coolify)
 *   POST /job                — submit a job (render | stills | preview)
 *   GET  /job/:id/status     — poll job status + telemetry
 *   POST /job/:id/patch      — click-to-edit via linkedom DOM parser (R5)
 *   GET  /preview/:id?token= — HMAC-signed preview for the Studio iframe
 *   GET  /warmup             — Chromium cold-start mitigation (R1)
 *
 * Job payload contract (V4_01_INFRA §3):
 *   { job_id, project_id, mode: 'render'|'stills'|'preview',
 *     inputs:  { index_html_url?, assets_tar_url?, fixture? },  // signed GET
 *     outputs: { mp4_upload_url?, snapshots_upload_url? },      // signed PUT
 *     options: { quality?, fps? },
 *     callback:{ url, secret } }
 *
 * Telemetry (R6): timings per phase + token counters are returned in the
 * callback body (`timings`, `tokens`).
 */

import express from "express";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { verifyPreviewToken } from "./preview-token.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Patch selector whitelist (R5): only #id and [data-edit="…"] ──────
const ID_SELECTOR = /^#[A-Za-z][\w-]*$/;
const DATA_EDIT_SELECTOR = /^\[data-edit=(["'])([A-Za-z][\w-]*)\1\]$/;

export function validateJobPayload(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  const { job_id, project_id, mode, inputs, callback } = body;
  if (typeof job_id !== "string" || !job_id) return "job_id required";
  if (typeof project_id !== "string" || !project_id) return "project_id required";
  if (!["render", "stills", "preview"].includes(mode)) return "mode must be render|stills|preview";
  if (!inputs || typeof inputs !== "object") return "inputs required";
  if (!inputs.index_html_url && !inputs.fixture) return "inputs.index_html_url or inputs.fixture required";
  if (inputs.fixture && !/^[a-z0-9_-]+$/i.test(inputs.fixture)) return "invalid fixture name";
  if (!callback || typeof callback.url !== "string" || typeof callback.secret !== "string") {
    return "callback.url and callback.secret required";
  }
  return null;
}

/**
 * App factory — config injectable for contract tests.
 * config: { workDir, fixturesDir, previewSecret, workers, hyperframesBin, now }
 */
export function createWorkerApp(config = {}) {
  const WORK_DIR = config.workDir || process.env.WORK_DIR || "/tmp/hyperframes-worker";
  const FIXTURES_DIR = config.fixturesDir || process.env.FIXTURES_DIR || join(__dirname, "fixtures");
  const PREVIEW_SECRET = config.previewSecret || process.env.PREVIEW_SECRET || "";
  const MAX_WORKERS = Number(config.workers || process.env.WORKERS || 1); // R3: pin 1 worker
  const HF_BIN = config.hyperframesBin || process.env.HYPERFRAMES_BIN || "hyperframes";
  const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";

  const app = express();
  app.use(express.json({ limit: "200mb" }));

  /** @type {Map<string, object>} */
  const jobs = new Map();
  const queue = [];
  let active = 0;
  let warm = false;

  // ── Health ────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ ok: true, ts: Date.now(), chrome: CHROME_PATH, workers: MAX_WORKERS, warm, active, queued: queue.length });
  });

  // ── Warmup (R1: ~15s Chromium cold start) ─────────────────────────
  app.get("/warmup", async (_req, res) => {
    const result = await warmup();
    res.json(result);
  });

  async function warmup() {
    try {
      // R1 + browser gerido: garante o Chrome Headless Shell (cache após 1ª vez)
      // antes do primeiro render.
      spawnSync(HF_BIN, ["browser", "ensure"], { encoding: "utf-8", timeout: 300_000, stdio: "ignore" });
      const probe = spawnSync(HF_BIN, ["--version"], { encoding: "utf-8", timeout: 30_000 });
      warm = probe.status === 0;
      return { ok: warm, version: (probe.stdout || probe.stderr || "").trim() || null };
    } catch {
      warm = false;
      return { ok: false, version: null };
    }
  }

  // ── Submit job ────────────────────────────────────────────────────
  app.post("/job", (req, res) => {
    const error = validateJobPayload(req.body);
    if (error) return res.status(400).json({ error });
    const { job_id } = req.body;
    if (jobs.has(job_id)) return res.status(409).json({ error: "job already exists" });

    const jobDir = join(WORK_DIR, job_id);
    const job = {
      ...req.body,
      status: "queued",
      created_at: new Date().toISOString(),
      job_dir: jobDir,
      timings: {},
      tokens: { llm_input: 0, llm_output: 0 },
    };
    jobs.set(job_id, job);
    queue.push(job_id);
    pump();
    res.status(202).json({ job_id, status: "queued" });
  });

  function pump() {
    while (active < MAX_WORKERS && queue.length > 0) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job) continue;
      active += 1;
      runJob(job).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  // ── Poll status ───────────────────────────────────────────────────
  app.get("/job/:id/status", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    const { callback: _cb, ...safe } = job; // never leak the callback secret
    res.json(safe);
  });

  // ── Patch (click-to-edit — linkedom DOM parser, R5) ───────────────
  // O patch é aplicado a TODOS os jobs em stage do mesmo projeto: o preview
  // serve o job mais recente, que pode ser diferente do job referenciado.
  app.post("/job/:id/patch", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });

    const { selector, text } = req.body || {};
    if (typeof selector !== "string" || typeof text !== "string") {
      return res.status(400).json({ error: "selector and text (strings) required" });
    }
    if (!ID_SELECTOR.test(selector) && !DATA_EDIT_SELECTOR.test(selector)) {
      return res.status(400).json({ error: "only #id and [data-edit=\"…\"] selectors are supported" });
    }

    const projectJobs = [...jobs.values()].filter((j) => j.project_id === job.project_id);
    let patchedCount = 0;
    let foundSelector = false;
    for (const pj of projectJobs) {
      const indexPath = join(pj.job_dir, "index.html");
      if (!existsSync(indexPath)) continue;
      const { document } = parseHTML(readFileSync(indexPath, "utf-8"));
      const el = document.querySelector(selector);
      if (!el) continue;
      foundSelector = true;
      el.textContent = text;
      writeFileSync(indexPath, document.toString());
      patchedCount += 1;
    }
    if (!foundSelector) return res.status(404).json({ error: `selector not found: ${selector}` });
    res.json({ ok: true, patched: selector, new_text: text, patched_jobs: patchedCount });
  });

  // ── Preview (HMAC token auth) ─────────────────────────────────────
  app.get("/preview/:id", (req, res) => {
    // Jobs are keyed by job_id; preview uses project_id → latest job wins.
    const projectJobs = [...jobs.values()].filter((j) => j.project_id === req.params.id);
    const job = projectJobs[projectJobs.length - 1];
    if (!job) return res.status(404).json({ error: "not found" });

    if (!PREVIEW_SECRET) return res.status(503).json({ error: "preview auth not configured" });
    if (!verifyPreviewToken(req.query.token, req.params.id, PREVIEW_SECRET)) {
      return res.status(401).json({ error: "invalid or expired token" });
    }

    const indexPath = join(job.job_dir, "index.html");
    if (!existsSync(indexPath)) return res.status(404).json({ error: "index.html not staged" });
    res.sendFile(indexPath);
  });

  app.get("/preview/:id/*", (req, res) => {
    const projectJobs = [...jobs.values()].filter((j) => j.project_id === req.params.id);
    const job = projectJobs[projectJobs.length - 1];
    if (!job) return res.status(404).json({ error: "not found" });
    if (!PREVIEW_SECRET) return res.status(503).json({ error: "preview auth not configured" });
    if (!verifyPreviewToken(req.query.token, req.params.id, PREVIEW_SECRET)) {
      return res.status(401).json({ error: "invalid or expired token" });
    }
    const rel = req.params[0];
    const filePath = join(job.job_dir, rel);
    // Path traversal guard: resolved path must stay inside the job dir.
    if (!filePath.startsWith(join(job.job_dir, "")) || !existsSync(filePath)) {
      return res.status(404).json({ error: "asset not found" });
    }
    res.sendFile(filePath);
  });

  // ── Job runner ────────────────────────────────────────────────────
  async function runJob(job) {
    job.status = "running";
    job.started_at = new Date().toISOString();
    const start = Date.now();
    try {
      mkdirSync(join(job.job_dir, "assets"), { recursive: true });

      // 1. Stage inputs (fixture bundle OR signed URLs)
      const tStage = Date.now();
      if (job.inputs.fixture) {
        stageFixture(job.inputs.fixture, job.job_dir);
      } else {
        await downloadTo(job.inputs.index_html_url, join(job.job_dir, "index.html"));
        if (job.inputs.assets_tar_url) {
          const tarPath = join(job.job_dir, "assets.tar");
          await downloadTo(job.inputs.assets_tar_url, tarPath);
          await extractTar(tarPath, job.job_dir);
        }
      }
      job.timings.stage_ms = Date.now() - tStage;

      // 2. Pipeline by mode ('preview' stops after staging)
      if (job.mode !== "preview") {
        await runPipeline(job);
      }

      // 3. Upload outputs via signed PUT URLs
      const tUpload = Date.now();
      job.outputs = job.outputs || {};
      const uploaded = {};
      const mp4Path = join(job.job_dir, "renders", "output.mp4");
      if (job.outputs.mp4_upload_url && existsSync(mp4Path)) {
        await uploadSigned(job.outputs.mp4_upload_url, mp4Path, "video/mp4");
        uploaded.mp4 = true;
      }
      const sheetPath = join(job.job_dir, "snapshots", "contact-sheet.jpg");
      if (job.outputs.snapshots_upload_url && existsSync(sheetPath)) {
        await uploadSigned(job.outputs.snapshots_upload_url, sheetPath, "image/jpeg");
        uploaded.contact_sheet = true;
      }
      job.timings.upload_ms = Date.now() - tUpload;
      job.uploaded = uploaded;

      job.status = "done";
      job.completed_at = new Date().toISOString();
    } catch (err) {
      job.status = "failed";
      job.error = err?.message || String(err);
    } finally {
      job.total_ms = Date.now() - start;
      await sendCallback(job);
    }
  }

  async function sendCallback(job) {
    const body = {
      job_id: job.job_id,
      project_id: job.project_id,
      step: job.step || job.mode,
      status: job.status,
      error: job.error || null,
      timings: job.timings,
      tokens: job.tokens,
      uploaded: job.uploaded || {},
      total_ms: job.total_ms,
    };
    try {
      await fetch(job.callback.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Worker-Secret": job.callback.secret },
        body: JSON.stringify(body),
      });
      job.callback_delivered = true;
    } catch (err) {
      job.callback_delivered = false;
      job.callback_error = err?.message || String(err);
    }
  }

  function stageFixture(name, jobDir) {
    const src = join(FIXTURES_DIR, name);
    if (!existsSync(src)) throw new Error(`fixture not found: ${name}`);
    copyTree(src, jobDir);
  }

  async function downloadTo(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${dest}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }

  async function uploadSigned(url, srcPath, contentType) {
    const buf = readFileSync(srcPath);
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: buf });
    if (!res.ok) throw new Error(`upload failed (${res.status}): ${srcPath}`);
  }

  function extractTar(tarPath, destDir) {
    return new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xf", tarPath, "-C", destDir], { stdio: "ignore" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
      child.on("error", reject);
    });
  }

  function hf(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(HF_BIN, args, {
        cwd: undefined,
        env: { ...process.env, CHROME_PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let errOut = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`hyperframes ${args[0]} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (errOut += d));
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`hyperframes ${args[0]} exit ${code}: ${errOut.slice(0, 500)}`));
      });
    });
  }

  async function runPipeline(job) {
    const dir = job.job_dir;
    const quality = job.options?.quality || "high";

    const tLint = Date.now();
    await hf(["lint", "--json", dir], 60_000);
    job.timings.lint_ms = Date.now() - tLint;

    const tCheck = Date.now();
    await hf(["check", "--json", dir], 120_000);
    job.timings.check_ms = Date.now() - tCheck;

    const tSnap = Date.now();
    await hf(["snapshot", "--frames", "5", dir], 120_000);
    job.timings.snapshot_ms = Date.now() - tSnap;

    if (job.mode === "render") {
      mkdirSync(join(dir, "renders"), { recursive: true });
      const out = join(dir, "renders", "output.mp4");
      const tRender = Date.now();
      await hf(["render", "--quality", quality, "-o", out, dir], 900_000);
      job.timings.render_ms = Date.now() - tRender;
      job.result = {
        mp4_bytes: existsSync(out) ? statSync(out).size : 0,
        snapshots: existsSync(join(dir, "snapshots"))
          ? readdirSync(join(dir, "snapshots")).filter((f) => /\.(png|jpg)$/.test(f))
          : [],
      };
    }
  }

  return { app, jobs, warmup, _internal: { queue: () => queue, active: () => active } };
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

// ── Main ────────────────────────────────────────────────────────────
// argv[1] pode ser relativo (Docker CMD ["node", "server.js"]) — comparar
// também com o caminho resolvido a partir do cwd.
const selfPath = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] &&
  (selfPath === process.argv[1] || selfPath === resolve(process.cwd(), process.argv[1]));
if (isMain) {
  const PORT = Number(process.env.PORT || 8787);
  const { app, warmup } = createWorkerApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[hyperframes-worker] listening on :${PORT} (WORKERS=${process.env.WORKERS || 1})`);
    // R1: warm the HyperFrames CLI / Chromium pool at boot (best-effort).
    warmup().then((r) => console.log(`[hyperframes-worker] warmup: ${JSON.stringify(r)}`));
  });
}
