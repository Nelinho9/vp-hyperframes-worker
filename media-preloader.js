/**
 * Media pre-loader for the HyperFrames render worker.
 *
 * Before invoking `hyperframes render`, the worker parses the composition HTML,
 * downloads external <video>/<audio>/<img> sources, validates them, rewrites the
 * HTML to use local (or inline) assets, and isolates the extraction cache.
 *
 * This prevents `moov atom not found` errors caused by:
 *   - URLs that return HTML/player pages instead of real MP4 files
 *   - Truncated downloads
 *   - Corrupted shared extraction caches
 *
 * V4-3f.13 — image pre-staging: the HyperFrames compiler localizes remote
 * <img> sources but names extension-less URLs `.mp4` (getFilenameFromUrl
 * default). An SVG served from a Supabase signed URL (path `.../asset-0`, no
 * extension) therefore lands on disk as `download_<hash>.mp4`; the render's
 * HDR image probe then ffprobes it and, on container ffprobe builds without an
 * SVG demuxer, dies with "moov atom not found". We pre-stage <img> ourselves:
 * SVG payloads are inlined as base64 data URIs (browser renders them natively
 * and ffprobe never sees a file), raster images are saved with a correct
 * extension, and anything else is rejected early with an actionable error.
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
 * @property {'video' | 'audio' | 'image'} tag
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

  // Match <video|audio|img ... src="..." ...>. This regex is intentionally
  // strict: it only catches src attributes inside media open tags. It does not
  // handle malformed HTML, but the LLM output is expected to be well-formed.
  const tagRe = /<(video|audio|img)\b([^>]*)>/gis;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const rawTag = m[1].toLowerCase();
    const tag = rawTag === "img" ? "image" : rawTag;
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
 * Fetch a URL into a Buffer, enforcing HTTP success and the size cap. Shared
 * by the video/audio and image pre-staging paths.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, reason: string, detail: string }>}
 */
async function fetchMediaBuffer(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  let res;
  try {
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

  // Validate content-length hints early, but be permissive (some CDNs omit it).
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return {
      ok: false,
      reason: "download_failed",
      detail: `file too large (${Number(contentLength)} bytes > ${maxBytes})`,
    };
  }

  let buffer;
  if (typeof res.arrayBuffer === "function") {
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
  } else {
    const body = res.body;
    if (!body) {
      return { ok: false, reason: "download_failed", detail: "empty response body" };
    }
    buffer = await streamToBuffer(body, maxBytes);
  }
  if (buffer.length > maxBytes) {
    return { ok: false, reason: "download_failed", detail: `file exceeds ${maxBytes} bytes` };
  }
  return { ok: true, buffer };
}

/**
 * Sniff the real image container from magic bytes (content-type headers from
 * capture uploads are not reliable — e.g. an image/png object holding JPEG).
 *
 * @param {Buffer} buffer
 * @returns {'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'unknown'}
 */
export function sniffImageKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    // SVG can be short; still sniff text below for tiny payloads.
  }
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
    if (buffer.slice(0, 4).toString("ascii") === "GIF8") return "gif";
    if (
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
    ) {
      return "webp";
    }
  }
  const head = buffer.slice(0, 1024).toString("utf8").replace(/^\ufeff/, "").trim();
  if (/^<svg[\s>]/i.test(head) || /^<\?xml[\s\S]*?<svg[\s>]/i.test(head) || /<!doctype\s+svg/i.test(head)) {
    return "svg";
  }
  return "unknown";
}

/**
 * Download an external <img> source and make it render-safe.
 *
 * SVG payloads are returned as a base64 data URI (no file on disk) so the
 * render's HDR image probe never ffprobes them and the browser rasterizes them
 * natively. Raster payloads are written with a correct extension. Anything else
 * (HTML player pages, truncated bodies, unknown containers) is rejected.
 *
 * @param {string} url
 * @param {string} assetsDir
 * @param {string} hash
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{ ok: true, dataUri?: string, path?: string, assetName?: string, kind: string } | { ok: false, reason: string, detail: string }>}
 */
export async function downloadAndValidateImage(url, assetsDir, hash, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  log = () => {},
} = {}) {
  log(`[media-preloader] downloading image ${url.slice(0, 120)}...`);
  const fetched = await fetchMediaBuffer(url, { fetchImpl, timeoutMs, maxBytes });
  if (!fetched.ok) return fetched;
  const buffer = fetched.buffer;
  const kind = sniffImageKind(buffer);

  if (kind === "svg") {
    // base64 keeps the data URI free of quote/angle characters so it can be
    // spliced straight into an src="..." attribute.
    const dataUri = `data:image/svg+xml;base64,${buffer.toString("base64")}`;
    log(`[media-preloader] inlining SVG as data URI (${buffer.length} bytes)`);
    return { ok: true, dataUri, kind };
  }

  const extByKind = { png: ".png", jpeg: ".jpg", gif: ".gif", webp: ".webp" };
  const ext = extByKind[kind];
  if (!ext) {
    const textHead = buffer.slice(0, 64).toString("utf8").replace(/\s+/g, " ").slice(0, 80);
    return {
      ok: false,
      reason: "not_image",
      detail: `response is not a recognized image format (head: "${textHead}")`,
    };
  }

  mkdirSync(assetsDir, { recursive: true });
  const assetName = `vp-media-${hash}${ext}`;
  const destPath = join(assetsDir, assetName);
  writeFileSync(destPath, buffer);
  log(`[media-preloader] staged image ${assetName} (${buffer.length} bytes, ${kind})`);
  return { ok: true, path: destPath, assetName, kind };
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

  log(`[media-preloader] downloading ${url.slice(0, 120)}...`);
  const fetched = await fetchMediaBuffer(url, { fetchImpl, timeoutMs, maxBytes });
  if (!fetched.ok) return fetched;
  const buffer = fetched.buffer;

  const tempPath = `${destPath}.tmp-${randomBytes(4).toString("hex")}`;
  try {
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
      const audioStream = (parsed?.streams ?? []).find((s) => s.codec_type === "audio");
      resolve({
        ok: true,
        duration: format.duration ? Number(format.duration) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        // V5-P5A: audio-stream exposure for the <audio> pre-stage branch.
        hasAudioStream: Boolean(audioStream),
        audioCodec: audioStream?.codec_name,
      });
    });
  });
}

/**
 * V5-P5A: sniff the audio container from magic bytes (content-type headers
 * from TTS providers are not always canonical).
 *
 * @param {Buffer} buffer
 * @returns {'mp3' | 'wav' | 'm4a' | null}
 */
export function sniffAudioKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return "mp3"; // "ID3"
  // MPEG frame sync: first 11 bits set (0xFF Ex/Fx).
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "mp3";
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WAVE"
  ) {
    return "wav";
  }
  // MP4/M4A family: uint32 size + "ftyp" at offset 4. Whether it is really
  // AUDIO-only is decided by ffprobe (codec_type), not here.
  if (
    buffer.length >= 8 &&
    buffer.slice(4, 8).toString("ascii") === "ftyp"
  ) {
    return "m4a";
  }
  return null;
}

/**
 * V5-P5A: download an external <audio> source and make it render-safe.
 *
 * The payload must be a recognized audio container (magic bytes) AND ffprobe
 * must report an audio stream — anything else (HTML player pages, video-only
 * payloads, garbage) is rejected early with `not_audio`. Saved with the
 * CORRECT extension (end of the hardcoded `.mp4` era for voice files).
 *
 * @param {string} url
 * @param {string} assetsDir
 * @param {string} hash
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.ffprobePath]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {(msg: string) => void} [options.log]
 * @param {(command: string, args: string[]) => import('child_process').ChildProcess} [options.spawnImpl]
 * @returns {Promise<{ ok: true, path: string, assetName?: string, kind?: string, duration?: number } | { ok: false, reason: string, detail: string }>}
 */
export async function downloadAndValidateAudio(url, assetsDir, hash, {
  fetchImpl = globalThis.fetch,
  ffprobePath = "ffprobe",
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  log = () => {},
  spawnImpl = defaultSpawn,
} = {}) {
  log(`[media-preloader] downloading audio ${url.slice(0, 120)}...`);
  const fetched = await fetchMediaBuffer(url, { fetchImpl, timeoutMs, maxBytes });
  if (!fetched.ok) return fetched;
  const buffer = fetched.buffer;

  const kind = sniffAudioKind(buffer);
  if (!kind) {
    const textHead = buffer.slice(0, 64).toString("utf8").replace(/\s+/g, " ").slice(0, 80);
    return {
      ok: false,
      reason: "not_audio",
      detail: `response is not a recognized audio container (head: "${textHead}")`,
    };
  }

  const extByKind = { mp3: ".mp3", wav: ".wav", m4a: ".m4a" };
  const assetName = `vp-media-${hash}${extByKind[kind]}`;
  const destPath = join(assetsDir, assetName);

  const tempPath = `${destPath}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(tempPath, buffer);

    // ffprobe validation — MUST contain an audio stream.
    const probe = await runFfprobe(ffprobePath, tempPath, spawnImpl);
    if (!probe.ok) {
      return { ok: false, reason: "ffprobe_failed", detail: probe.error };
    }
    if (!probe.hasAudioStream) {
      return {
        ok: false,
        reason: "not_audio",
        detail: `container ${kind} carries no audio stream${probe.codec ? ` (found: ${probe.codec})` : ""}`,
      };
    }

    renameSync(tempPath, destPath);
    log(`[media-preloader] staged audio ${assetName} (${probe.duration?.toFixed(2) ?? "?"}s)`);
    return { ok: true, path: destPath, assetName, kind, duration: probe.duration };
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

/**
 * Rewrite HTML so external video/audio/img src attributes point to local
 * files (or inline data URIs for SVG images).
 *
 * @param {string} html
 * @param {Record<string, string>} mapping originalUrl -> localRelativePath|dataUri
 * @returns {string}
 */
export function rewriteHtmlMediaUrls(html, mapping) {
  if (typeof html !== "string") return html;
  if (!mapping || Object.keys(mapping).length === 0) return html;

  // Replace only src values that exactly match a known original URL and that
  // live inside a video/audio/img tag. This avoids touching unrelated elements.
  const tagRe = /<(video|audio|img)\b([^>]*)>/gis;
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
 * @param {(command: string, args: string[]) => import('child_process').ChildProcess} [options.spawnImpl]
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

  for (const { tag, originalSrc } of urls) {
    const hash = urlHash(originalSrc);

    // V4-3f.13: images get content-sniffed handling (SVG -> inline data URI,
    // raster -> correct extension). Leaving them to the CLI would name every
    // extension-less capture URL `.mp4` and break the render's image probing.
    if (tag === "image") {
      const result = await downloadAndValidateImage(originalSrc, assetsDir, hash, options);
      if (result.ok) {
        mapping[originalSrc] = result.dataUri ?? `assets/${result.assetName}`;
        downloaded.push(originalSrc);
      } else {
        failures.push({ url: originalSrc, reason: result.reason, detail: result.detail });
      }
      continue;
    }

    // V5-P5A: <audio> (real TTS voice / BGM) gets container sniffing + an
    // ffprobe audio-stream requirement and is saved with the CORRECT
    // extension — the old hardcoded `.mp4` path rejected every mp3/wav with
    // `not_mp4`, killing the whole job at staging.
    if (tag === "audio") {
      const result = await downloadAndValidateAudio(originalSrc, assetsDir, hash, options);
      if (result.ok) {
        mapping[originalSrc] = `assets/${result.assetName}`;
        downloaded.push(originalSrc);
      } else {
        failures.push({ url: originalSrc, reason: result.reason, detail: result.detail });
      }
      continue;
    }

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
