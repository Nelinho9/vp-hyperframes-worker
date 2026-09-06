/**
 * V5-P2D (master plan §7.3): per-scene timeline thumbnails.
 *
 * One CLI boot per artifact: the vendored hyperframes snapshot command
 * accepts explicit timestamps (`--at t1,t2 --no-end --describe false`),
 * so every ROOT scene window contributes exactly one frame (its midpoint).
 * Results live in `{jobDir}/thumbs/` next to a per-artifact manifest
 * (`manifest-<sha1>.json`) that short-circuits any later request for the
 * SAME composition HTML — the cache key §7.3 asks for.
 *
 * The quality-gate `snapshots/` directory is never touched (separate -o).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseHTML } from "linkedom";

const SNAPSHOT_TIMEOUT_MS = Number(process.env.THUMBNAILS_TIMEOUT_MS || 90000);

/** sha1 hex of the served composition HTML — the artifact identity. */
export function computeArtifactHash(html) {
  return createHash("sha1").update(html, "utf-8").digest("hex");
}

/**
 * Midpoint seconds of every clip owned by the composition root — the SAME
 * ownership rule as patch-engine normalizeClipWindows (nested composition
 * internals keep their own timeline and are ignored).
 *
 * NOTE (V5.22 Fase H3): thumbnails keep the MIDPOINT on purpose (scene
 * overview). The quality-gate snapshots use parseScenePostEntranceTimes
 * below (post-entrance presence) — intentional divergence, see E5/H3.
 */
export function parseSceneMidpoints(html, fps = 30) {
  void fps;
  const { document } = parseHTML(html);
  const rootEl = document.querySelector("[data-composition-id]");
  const clips = Array.from(document.querySelectorAll(".clip")).filter((el) => {
    const owner = el.closest ? el.closest("[data-composition-id]") : null;
    return owner === null || owner === rootEl;
  });
  const times = [];
  for (const el of clips) {
    const start = parseFloat(el.getAttribute("data-start"));
    const duration = parseFloat(el.getAttribute("data-duration"));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue;
    // Quantize to ms so the value round-trips through the CLI filename label
    // (formatSnapshotTimestamp uses toFixed(3)).
    times.push(Math.round((start + duration / 2) * 1000) / 1000);
  }
  times.sort((a, b) => a - b);
  return times;
}

/**
 * V5.22 Fase H3: per-scene POST-ENTRANCE times for the quality-gate render
 * snapshots — the client-side contract of `scenePostEntranceFrame`
 * (timelineV4Model.ts): `min(start + 1.5s, midpoint, end - margin)`.
 *
 * Why: `snapshot --frames 5` samples uniformly INCLUDING t=0, where
 * spring-pop/fromTo entrances (~1s) have not run yet — a sampler-vs-entrance
 * mismatch (E5/H0), not a composition defect. Post-entrance sampling keeps
 * 1 frame/scene (max 5, temporal order) so the VLM sees what the user sees.
 * Thumbnails (overview) intentionally keep midpoints — see parseSceneMidpoints.
 *
 * Short scenes degrade honestly: when start+offset exceeds the midpoint the
 * min() picks the midpoint; the end-margin guard keeps every time strictly
 * inside [start, end). No scenes / unreadable HTML → [] (caller falls back
 * to the legacy `--frames 5`).
 */
export const RENDER_SNAPSHOT_POST_ENTRANCE_OFFSET_S = 1.5;
export const RENDER_SNAPSHOT_END_MARGIN_S = 0.05;
export const MAX_RENDER_SNAPSHOTS = 5;

export function parseSceneWindows(html) {
  const { document } = parseHTML(html);
  const rootEl = document.querySelector("[data-composition-id]");
  const clips = Array.from(document.querySelectorAll(".clip")).filter((el) => {
    const owner = el.closest ? el.closest("[data-composition-id]") : null;
    return owner === null || owner === rootEl;
  });
  const windows = [];
  for (const el of clips) {
    const start = parseFloat(el.getAttribute("data-start"));
    const duration = parseFloat(el.getAttribute("data-duration"));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue;
    windows.push({ start, end: start + duration });
  }
  windows.sort((a, b) => a.start - b.start);
  return windows;
}

export function parseScenePostEntranceTimes(
  html,
  { offsetS = RENDER_SNAPSHOT_POST_ENTRANCE_OFFSET_S, maxScenes = MAX_RENDER_SNAPSHOTS, endMarginS = RENDER_SNAPSHOT_END_MARGIN_S } = {},
) {
  let windows = [];
  try {
    windows = parseSceneWindows(html);
  } catch {
    return [];
  }
  const times = [];
  for (const { start, end } of windows) {
    const midpoint = start + (end - start) / 2;
    const candidates = [start + offsetS, midpoint];
    const cap = end - endMarginS;
    if (cap > start) candidates.push(cap);
    let t = Math.min(...candidates);
    if (!(t >= start)) t = start;
    if (!(t < end)) t = Math.min(midpoint, cap > start ? cap : start);
    times.push(Math.round(t * 1000) / 1000);
  }
  times.sort((a, b) => a - b);
  return times.slice(0, maxScenes);
}

/**
 * Canonical CLI invocation for the quality-gate render snapshots:
 * `snapshot --at t1,t2 --no-end --describe false <jobDir>` (default output
 * `<jobDir>/snapshots/`). `--no-end` is REQUIRED: without it the CLI
 * appends a tail frame (6th frame, breaks MAX 5). `--describe false`
 * guarantees zero Gemini side effects/cost. Empty times → caller falls back
 * to the legacy `snapshot --frames 5`.
 */
export function buildRenderSnapshotArgs(times, projectDir) {
  const command = process.env.HYPERFRAMES_BIN || "npx";
  const args = process.env.HYPERFRAMES_BIN
    ? ["snapshot"]
    : ["hyperframes", "snapshot"];
  args.push(
    "--at", times.map((t) => String(Math.round(t * 1000) / 1000)).join(","),
    "--no-end",
    "--describe", "false",
    projectDir,
  );
  return { command, args };
}

/**
 * Rollback switch without a code redeploy: `RENDER_SNAPSHOTS_LEGACY_FRAMES=1`
 * restores the pre-H3 `snapshot --frames 5` (t≈0 sampling).
 */
export function renderSnapshotsLegacyFrames(env = process.env) {
  const raw = env.RENDER_SNAPSHOTS_LEGACY_FRAMES;
  if (raw === undefined || raw === null || raw === "") return false;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/**
 * Canonical CLI invocation. Mirrors runCheck/runRender: HYPERFRAMES_BIN
 * replaces `npx hyperframes`; `--no-end` keeps ONLY our exact times and
 * `--describe false` guarantees zero Gemini side effects/cost.
 */
export function buildSnapshotCommandArgs(times, outDir, projectDir) {
  const command = process.env.HYPERFRAMES_BIN || "npx";
  const args = process.env.HYPERFRAMES_BIN
    ? ["snapshot"]
    : ["hyperframes", "snapshot"];
  args.push(
    "--at", times.map((t) => String(Math.round(t * 1000) / 1000)).join(","),
    "--no-end",
    "--describe", "false",
    "-o", outDir,
    projectDir,
  );
  return { command, args };
}

/** Default runner when none is injected (same semantics as server.spawnCommand). */
function defaultSpawnRun(command, args, opts = {}) {
  const { timeout = SNAPSHOT_TIMEOUT_MS, env = process.env } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    child.stdout?.on("data", (c) => { stdout += c.toString(); });
    child.stderr?.on("data", (c) => { stderr += c.toString(); });
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

// In-flight dedup: concurrent requests for the same artifact share ONE capture.
const inflight = new Map();

function readCachedManifest(manifestPath) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!raw || !Array.isArray(raw.items)) return null;
    return raw;
  } catch {
    return null; // corrupt/stale manifest → re-capture
  }
}

/** PNG files produced by the CLI follow `frame-{ii}-at-{t}s.png`. */
function collectSnapshotFiles(outDir) {
  const items = [];
  for (const file of readdirSync(outDir)) {
    const match = /^frame-(\d+)-at-(.+)\.png$/.exec(file);
    if (!match) continue;
    items.push({ index: Number(match[1]), time_s: parseFloat(match[2]), file });
  }
  items.sort((a, b) => a.index - b.index);
  return items.map(({ time_s, file }) => ({ time_s, file }));
}

/**
 * Ensure thumbnails exist for this artifact and return their manifest.
 *
 * @param {{ jobDir: string, html: string, fps?: number, run?: Function,
 *           env?: object, timeoutMs?: number }} input
 * @returns {Promise<{ artifact: string, fps: number, items: Array<{time_s:number,file:string}>, cached: boolean }>}
 */
export async function captureThumbnails({ jobDir, html, fps = 30, run, env, timeoutMs }) {
  const artifact = computeArtifactHash(html);
  const outDir = join(jobDir, "thumbs");
  const manifestPath = join(outDir, `manifest-${artifact}.json`);

  const cached = readCachedManifest(manifestPath);
  if (cached) {
    return { artifact, fps: cached.fps ?? fps, items: cached.items, cached: true };
  }

  const dedupKey = `${jobDir}:${artifact}`;
  const existing = inflight.get(dedupKey);
  if (existing) return existing;

  const job = (async () => {
    const times = parseSceneMidpoints(html, fps);
    if (times.length === 0) {
      const empty = { artifact, fps, items: [], cached: false };
      mkdirSync(outDir, { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(empty));
      return empty;
    }
    mkdirSync(outDir, { recursive: true });
    const { command, args } = buildSnapshotCommandArgs(times, outDir, jobDir);
    const doRun = run || defaultSpawnRun;
    const result = await doRun(command, args, {
      timeout: timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
      env: env ?? process.env,
    });
    if (result.timedOut || result.code !== 0) {
      throw new Error(
        `thumbnail snapshot failed (exit ${result.code}${result.timedOut ? ", timeout" : ""})`
          + (result.stderr ? `\n${String(result.stderr).slice(-2000)}` : ""),
      );
    }
    const manifest = { artifact, generated_at: new Date().toISOString(), fps, items: collectSnapshotFiles(outDir) };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return { ...manifest, cached: false };
  })();

  inflight.set(dedupKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(dedupKey);
  }
}
