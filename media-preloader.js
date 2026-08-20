/**
 * Media pre-loader for the HyperFrames render worker.
 *
 * Before invoking `hyperframes render`, the worker parses the composition HTML,
 * downloads external <video>/<audio> sources, validates them with ffprobe,
 * rewrites the HTML to use local assets, and isolates the extraction cache.
 *
 * This prevents `moov atom not found` errors caused by:
 *   - URLs that return HTML/player pages instead of real MP4 files
 *   - Truncated downloads
 *   - Corrupted shared extraction caches
 */

import { createHash, randomBytes } from "crypto";
import { spawn as defaultSpawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, basename } from "path";

const DEFAULT_MEDIA_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const MP4_MAGIC = Buffer.from("ftyp", "ascii");

/**
 * @typedef {object} MediaUrl
 * @property {'video' | 'audio'} tag
 * @property {string} originalSrc
 * @property {string} normalizedUrl
 */

/**
 * Extract external media URLs from composition HTML.
 *
 * @param {string} html
 * @returns {MediaUrl[]}
 */
export function extractMediaUrls(html) {
  if (typeof html !== "string") return [];
  const results = [];
  const seen = new Set();

  // Match <video ... src="..." ...> and <audio ... src="..." ...>.
  // This regex is intentionally strict: it only catches src attributes inside
  // video/audio open tags. It does not handle malformed HTML, but the LLM
  // output is expected to be well-formed.
  const tagRe = /<(video|audio)\b([^>]*)>/gis;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const originalSrc = srcMatch[1].trim();
    if (!/^https?:\/\//i.test(originalSrc)) continue; // skip local/relative/data/blob
    if (seen.has(originalSrc)) continue;
    seen.add(originalSrc);
    results.push({ tag, originalSrc, normalizedUrl: originalSrc });
  }
  return results;
}

function urlHash(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

function hasMp4Magic(buffer) {
  // MP4 container starts with a 32-bit size followed by "ftyp" at offset 4.
  if (buffer.length < 12) return false;
  const ftypOffset = buffer.indexOf(MP4_MAGIC);
  return ftypOffset >= 4 && ftypOffset <= 8;
}

function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function streamToBuffer(webStream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const reader = webStream.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          resolve(Buffer.concat(chunks));
          return;
        }
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          reader.releaseLock();
          reject(new Error(`file exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
        pump();
      }, reject);
    }
    pump();
  });
}

/**
 * Download a media URL, validate it is a real MP4, and run ffprobe.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.ffprobePath]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {(msg: string) => void} [options.log]
 * @param {(command: string, args: string[]) => import('child_process').ChildProcess} [options.spawnImpl]
 * @returns {Promise<{ ok: true, path: string, duration?: number, width?: number, height?: number, codec?: string } | { ok: false, reason: string, detail: string }>}
 */
export async function downloadAndValidateMedia(
  url,
  destPath,
  {
    fetchImpl = globalThis.fetch,
    ffprobePath = "ffprobe",
    timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    log = () => {},
    spawnImpl = defaultSpawn,
  } = {}
) {
  mkdirSync(dirname(destPath), { recursive: true });

  let res;
  try {
    log(`[media-preloader] downloading ${url.slice(0, 120)}...`);
    res = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  } catch (err) {
    return { ok: false, reason: "download_failed", detail: `fetch error: ${err?.message ?? err}` };
  }

  if (!res.ok) {
    const bodyPreview = await res.text().catch(() => "");
    return {
      ok: false,
      reason: "download_failed",
      detail: `HTTP ${res.status} ${res.statusText}${bodyPreview ? ` — ${bodyPreview.slice(0, 200)}` : ""}`,
    };
  }

  // Validate content-type hints early, but be permissive (some CDNs serve
  // video/mp4 without a content-type).
  const contentType = res.headers.get("content-type") || "";
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return {
      ok: false,
      reason: "download_failed",
      detail: `file too large (${Number(contentLength)} bytes > ${maxBytes})`,
    };
  }

  const tempPath = `${destPath}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    let buffer;
    if (typeof res.arrayBuffer === "function") {
      const ab = await res.arrayBuffer();
      buffer = Buffer.from(ab);
      if (buffer.length > maxBytes) {
        return {
          ok: false,
          reason: "download_failed",
          detail: `file exceeds ${maxBytes} bytes`,
        };
      }
    } else {
      const body = res.body;
      if (!body) {
        return { ok: false, reason: "download_failed", detail: "empty response body" };
      }
      buffer = await streamToBuffer(body, maxBytes);
    }

    writeFileSync(tempPath, buffer);

    // Magic-byte check.
    if (!hasMp4Magic(buffer)) {
      const textHead = buffer.slice(0, 64).toString("utf8").replace(/\s+/g, " ").slice(0, 80);
      return {
        ok: false,
        reason: "not_mp4",
        detail: `response does not start with MP4 magic bytes (head: "${textHead}")`,
      };
    }

    // ffprobe validation.
    const probe = await runFfprobe(ffprobePath, tempPath, spawnImpl);
    if (!probe.ok) {
      return { ok: false, reason: "ffprobe_failed", detail: probe.error };
    }

    renameSync(tempPath, destPath);
    log(`[media-preloader] validated ${basename(destPath)} (${probe.duration?.toFixed(2) ?? "?"}s)`);
    return { ok: true, path: destPath, ...probe };
  } catch (err) {
    return { ok: false, reason: "download_failed", detail: err?.message ?? String(err) };
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

function runFfprobe(ffprobePath, filePath, spawnImpl = defaultSpawn) {
  return new Promise((resolve) => {
    const child = spawnImpl(ffprobePath, [
      "-v", "error",
      "-show_format",
      "-show_streams",
      "-print_format", "json",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `ffprobe exited ${code}` });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve({ ok: true });
        return;
      }
      const format = parsed?.format ?? {};
      const videoStream = (parsed?.streams ?? []).find((s) => s.codec_type === "video");
      resolve({
        ok: true,
        duration: format.duration ? Number(format.duration) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
      });
    });
  });
}

/**
 * Rewrite HTML so external video/audio src attributes point to local files.
 *
 * @param {string} html
 * @param {Record<string, string>} mapping originalUrl -> localRelativePath
 * @returns {string}
 */
export function rewriteHtmlMediaUrls(html, mapping) {
  if (typeof html !== "string") return html;
  if (!mapping || Object.keys(mapping).length === 0) return html;

  // Replace only src values that exactly match a known original URL and that
  // live inside a video/audio tag. This avoids touching unrelated elements.
  const tagRe = /<(video|audio)\b([^>]*)>/gis;
  return html.replace(tagRe, (fullTag, tagName, attrs) => {
    const srcMatch = attrs.match(/(\bsrc\s*=\s*["'])([^"']+)(["'])/i);
    if (!srcMatch) return fullTag;
    const originalSrc = srcMatch[2];
    const localSrc = mapping[originalSrc];
    if (!localSrc) return fullTag;
    const newAttrs = `${attrs.slice(0, srcMatch.index)}${srcMatch[1]}${localSrc}${srcMatch[3]}${attrs.slice(srcMatch.index + srcMatch[0].length)}`;
    return `<${tagName}${newAttrs}>`;
  });
}

/**
 * Convenience: given an HTML string and a job directory, download and validate
 * all external media, rewrite the HTML, and return diagnostics.
 *
 * @param {string} html
 * @param {string} jobDir
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.ffprobePath]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{ ok: true, html: string, downloaded: string[], skipped: boolean } | { ok: false, reason: string, failures: Array<{ url: string, reason: string, detail: string }> }>}
 */
export async function prestageExternalMedia(html, jobDir, options = {}) {
  const urls = extractMediaUrls(html);
  if (urls.length === 0) {
    return { ok: true, html, downloaded: [], skipped: true };
  }

  const assetsDir = join(jobDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const mapping = {};
  const downloaded = [];
  const failures = [];

  for (const { originalSrc } of urls) {
    const hash = urlHash(originalSrc);
    const ext = ".mp4"; // we only accept validated mp4 containers
    const assetName = `vp-media-${hash}${ext}`;
    const destPath = join(assetsDir, assetName);

    if (existsSync(destPath)) {
      // Already downloaded in a previous run (e.g. preview -> render reuse).
      mapping[originalSrc] = `assets/${assetName}`;
      downloaded.push(originalSrc);
      continue;
    }

    const result = await downloadAndValidateMedia(originalSrc, destPath, options);
    if (result.ok) {
      mapping[originalSrc] = `assets/${assetName}`;
      downloaded.push(originalSrc);
    } else {
      failures.push({ url: originalSrc, reason: result.reason, detail: result.detail });
    }
  }

  if (failures.length > 0) {
    return { ok: false, reason: "MEDIA_VALIDATION_FAILED", failures };
  }

  return { ok: true, html: rewriteHtmlMediaUrls(html, mapping), downloaded, skipped: false };
}
