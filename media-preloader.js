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

import { fetchBounded } from "./bounded-fetch.js";
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
 * Opção A (F12-voz): máscara de URLs com segredo — origem + pathname, sem
 * query/hash/credenciais. Signed URLs do Storage são bearer tokens: nunca
 * persistem (evidence, job rows, logs) com `?token=`.
 */
export function maskMediaUrl(url) {
  try {
    const u = new URL(String(url ?? ""));
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "(invalid-url)";
  }
}

/** Remove query/hash de URLs embutidas em mensagens de erro/log. */
export function sanitizeMediaDetail(detail) {
  return String(detail ?? "").replace(/https?:\/\/[^\s"'<>]+/g, (m) => maskMediaUrl(m));
}

/**
 * @typedef {object} MediaUrl
 * @property {'video' | 'audio' | 'image' | 'track' | 'css' | 'unsupported'} tag
 * @property {string} originalSrc
 * @property {string} normalizedUrl
 * @property {string} attribute
 * @property {string} kind
 * @property {string} [descriptor]
 */

const RESOURCE_ATTRIBUTES = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  th: ['background'],
  script: ['src'],
  link: ['href'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
  base: ['href'],
};

const CONTAINER_TAGS = new Set(['video', 'audio', 'picture', 'svg']);
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// Quotes are part of the tag match so an attribute value containing `>` does
// not terminate the tag early (the old regex truncated such tags).
const TAG_PATTERN = /<!--[\s\S]*?-->|<![^>]*>|<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;

/**
 * Tokenizes a raw attribute string without confusing `data-src` with `src`.
 * @param {string} attrsText
 */
function tokenizeAttributes(attrsText) {
  const tokens = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(attrsText)) !== null) {
    if (match.index === re.lastIndex) {
      re.lastIndex += 1;
      continue;
    }
    const hasValue = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined;
    tokens.push({
      name: match[1],
      lower: match[1].toLowerCase(),
      value: hasValue ? (match[2] ?? match[3] ?? match[4]) : null,
      hasValue,
      raw: match[0],
      leading: attrsText.slice(lastIndex, match.index),
    });
    lastIndex = re.lastIndex;
  }
  return { tokens, trailing: attrsText.slice(lastIndex) };
}

/** Walks opening/closing tags with a container stack (video/audio/picture/svg). */
function walkTags(html, visitor) {
  const stack = [];
  TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAG_PATTERN.exec(html)) !== null) {
    if (match[2] === undefined) continue; // comment or doctype
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (closing) {
      const index = stack.lastIndexOf(tag);
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = match[3] ?? '';
    const selfClosing = /\/\s*$/.test(attrs);
    visitor({ tag, attrs, full: match[0], parent: stack[stack.length - 1] });
    if (selfClosing || VOID_TAGS.has(tag)) continue;
    if (CONTAINER_TAGS.has(tag)) stack.push(tag);
  }
}

function attrValue(attrsText, name) {
  const { tokens } = tokenizeAttributes(attrsText);
  const wanted = String(name).toLowerCase();
  const token = tokens.find((entry) => entry.lower === wanted && entry.hasValue);
  return token ? token.value : null;
}

/** Splits a srcset value into URL + descriptor pairs (data: kept as-is). */
function parseSrcset(value) {
  const out = [];
  const re = /(?:^|,)\s*([^\s,]+)(?:\s+([^,]+))?/g;
  let match;
  while ((match = re.exec(String(value ?? ''))) !== null) {
    const url = match[1];
    if (!url) continue;
    out.push({ url, descriptor: (match[2] ?? '').trim() });
  }
  return out;
}

function resourceKind(tag, attribute, parent) {
  if (tag === 'img' || tag === 'image' || attribute === 'poster' || attribute === 'background') {
    return 'image';
  }
  if (tag === 'source') {
    if (parent === 'picture') return 'image';
    if (parent === 'audio') return 'audio';
    return 'video';
  }
  if (tag === 'video') return 'video';
  if (tag === 'audio') return 'audio';
  if (tag === 'track') return 'track';
  if (tag === 'css') return 'image';
  return 'unsupported';
}

function collectCssUrls(cssText, add) {
  const re = new RegExp(CSS_URL_RE.source, CSS_URL_RE.flags);
  let match;
  while ((match = re.exec(String(cssText ?? ''))) !== null) {
    add(match[2], 'css', 'style', 'image');
  }
}

/**
 * Extract external resource URLs from composition HTML with real attribute
 * parsing: `data-src` is not `src`; `srcset`, `poster`, `<source>` (picture vs
 * video), SVG `href`, CSS `url(...)` and unsupported network elements are all
 * inventoried (AUD-B03).
 *
 * @param {string} html
 * @returns {MediaUrl[]}
 */
export function extractMediaUrls(html) {
  if (typeof html !== "string") return [];
  const results = [];
  const seen = new Set();

  const add = (rawUrl, tag, attribute, kind, descriptor) => {
    const originalSrc = String(rawUrl ?? '').trim();
    if (!/^https?:\/\//i.test(originalSrc)) return; // local/relative/data/blob
    if (seen.has(originalSrc)) return;
    seen.add(originalSrc);
    results.push({
      tag,
      originalSrc,
      normalizedUrl: originalSrc,
      attribute,
      kind,
      ...(descriptor ? { descriptor } : {}),
    });
  };

  walkTags(html, ({ tag, attrs, parent }) => {
    const defs = RESOURCE_ATTRIBUTES[tag];
    if (!defs) return;
    const publicTag = tag === 'img' ? 'image' : tag;
    const { tokens } = tokenizeAttributes(attrs);
    for (const token of tokens) {
      if (!defs.includes(token.lower) || !token.hasValue) continue;
      const kind = resourceKind(tag, token.lower, parent);
      if (token.lower === 'srcset') {
        for (const candidate of parseSrcset(token.value)) {
          add(candidate.url, publicTag, 'srcset', kind, candidate.descriptor);
        }
      } else {
        add(token.value, publicTag, token.lower, kind);
      }
    }
  });

  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    collectCssUrls(match[1], add);
  }
  for (const match of html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    collectCssUrls(match[1] ?? match[2], add);
  }

  return results;
}

function rewriteResourceValue(attribute, value, mapping, onChange) {
  if (attribute === 'srcset') {
    let changed = false;
    const rewritten = parseSrcset(value).map((candidate) => {
      const local = mapping[candidate.url];
      if (!local) return candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url;
      changed = true;
      return candidate.descriptor ? `${local} ${candidate.descriptor}` : local;
    }).join(', ');
    if (changed) onChange();
    return changed ? rewritten : value;
  }
  if (attribute === 'style') {
    let changed = false;
    const rewritten = String(value).replace(CSS_URL_RE, (full, quote, url) => {
      const local = mapping[url];
      if (!local) return full;
      changed = true;
      return `url(${quote}${local}${quote})`;
    });
    if (changed) onChange();
    return changed ? rewritten : value;
  }
  const local = mapping[String(value).trim()];
  if (!local) return value;
  onChange();
  return local;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Rewrite HTML so external media src/srcset/poster/CSS url values point to
 * local files (or inline data URIs for SVG images).
 *
 * @param {string} html
 * @param {Record<string, string>} mapping originalUrl -> localRelativePath|dataUri
 * @returns {string}
 */
export function rewriteHtmlMediaUrls(html, mapping) {
  if (typeof html !== "string") return html;
  if (!mapping || Object.keys(mapping).length === 0) return html;

  let changed = false;
  const onChange = () => { changed = true; };
  const rewritten = html.replace(TAG_PATTERN, (fullTag, closing, tagName, attrs) => {
    if (!tagName || closing) return fullTag;
    const tag = tagName.toLowerCase();
    const defs = RESOURCE_ATTRIBUTES[tag];
    if (!defs) return fullTag;
    const { tokens, trailing } = tokenizeAttributes(attrs);
    let rebuilt = '';
    for (const token of tokens) {
      let emitted = token.raw;
      if (token.hasValue && defs.includes(token.lower)) {
        const next = rewriteResourceValue(token.lower, token.value, mapping, onChange);
        if (next !== token.value) {
          emitted = `${token.name}="${escapeAttribute(next)}"`;
        }
      }
      rebuilt += token.leading + emitted;
    }
    return changed ? `<${tagName}${rebuilt}${trailing}>` : fullTag;
  });

  if (!changed) return html;
  return rewritten.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
    (_full, attrs, css) => {
      const nextCss = css.replace(CSS_URL_RE, (full, quote, url) => {
        const local = mapping[url];
        return local ? `url(${quote}${local}${quote})` : full;
      });
      return `<style${attrs}>${nextCss}</style>`;
    },
  );
}

/**
 * Removes network resources the worker cannot stage (external scripts,
 * stylesheets, frames, plugins, remote <base>) and remote CSS @import rules.
 * Known runtimes/fonts were already handled by runtime-vendor.js.
 */
export function stripUnsupportedRemoteResources(html) {
  if (typeof html !== 'string') return { html, stripped: [] };
  const stripped = [];
  const record = (tag, url) => stripped.push({ tag, url: maskMediaUrl(url) });

  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (fullTag) => {
    const attrs = /^<script\b([^>]*)>/i.exec(fullTag)?.[1] ?? '';
    const src = attrValue(attrs, 'src');
    if (src && /^https?:\/\//i.test(src)) {
      record('script', src);
      return '';
    }
    return fullTag;
  });

  out = out.replace(/<link\b[^>]*>/gi, (fullTag) => {
    const attrs = /^<link\b([^>]*)>/i.exec(fullTag)?.[1] ?? '';
    const href = attrValue(attrs, 'href');
    if (href && /^https?:\/\//i.test(href)) {
      record('link', href);
      return '';
    }
    return fullTag;
  });

  out = out.replace(/<base\b[^>]*>/gi, (fullTag) => {
    const attrs = /^<base\b([^>]*)>/i.exec(fullTag)?.[1] ?? '';
    const href = attrValue(attrs, 'href');
    if (href && /^https?:\/\//i.test(href)) {
      record('base', href);
      return '';
    }
    return fullTag;
  });

  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, (fullTag) => {
    const attrs = /^<iframe\b([^>]*)>/i.exec(fullTag)?.[1] ?? '';
    const src = attrValue(attrs, 'src');
    if (src && /^https?:\/\//i.test(src)) {
      record('iframe', src);
      return '';
    }
    return fullTag;
  });

  out = out.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, (fullTag) => {
    const attrs = /^<object\b([^>]*)>/i.exec(fullTag)?.[1] ?? '';
    const src = attrValue(attrs, 'data');
    if (src && /^https?:\/\//i.test(src)) {
      record('object', src);
      return '';
    }
    return fullTag;
  });

  out = out.replace(/<embed\b[^>]*>/gi, (fullTag) => {
    const attrs = /^<embed\b([^>]*)>/i.exec(fullTag)?.[1] ?? '';
    const src = attrValue(attrs, 'src');
    if (src && /^https?:\/\//i.test(src)) {
      record('embed', src);
      return '';
    }
    return fullTag;
  });

  out = out.replace(
    /@import\s+(?:url\(\s*)?["']?https?:\/\/[^;\n)"']+["']?\s*\)?\s*;?/gi,
    (fullRule) => {
      record('css', fullRule);
      return '';
    },
  );

  return { html: out, stripped };
}

/** Throws unless every remaining absolute resource URL is allowlisted. */
export function assertNoRemoteResources(html, { allowedOrigins = [] } = {}) {
  const allowed = new Set((allowedOrigins ?? []).map((origin) => String(origin).replace(/\/$/, '')));
  for (const entry of extractMediaUrls(html)) {
    const origin = new URL(entry.originalSrc).origin;
    if (allowed.has(origin)) continue;
    throw new Error(
      `UNSTAGED_REMOTE_RESOURCE:${entry.tag}:${entry.attribute}:${maskMediaUrl(entry.originalSrc)}`,
    );
  }
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) {
    throw new Error('UNSTAGED_REMOTE_RESOURCE:meta:refresh');
  }
  if (/@import\s+(?:url\(\s*)?["']?https?:/i.test(html)) {
    throw new Error('UNSTAGED_REMOTE_RESOURCE:css:import');
  }
}

const COMPOSITION_CSP = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'self' blob:",
].join('; ');

/**
 * Deny-by-default network policy for the compiler/browser: media, fonts,
 * scripts and styles stay local (or data:/blob:), while fetch/XHR, frames and
 * plugins are blocked. The CLI-injected runtime is same-origin ('self').
 */
export function hardenCompositionNetwork(html) {
  if (typeof html !== 'string') return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${COMPOSITION_CSP}">`;
  const withoutExisting = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi,
    '',
  );
  if (/<head\b[^>]*>/i.test(withoutExisting)) {
    return withoutExisting.replace(/<head\b[^>]*>/i, (head) => `${head}${meta}`);
  }
  if (/<html\b[^>]*>/i.test(withoutExisting)) {
    return withoutExisting.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${meta}</head>`);
  }
  return `${meta}${withoutExisting}`;
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

export async function fetchMediaBuffer(url, options = {}) {
  try {
    const { buffer } = await fetchBounded(url, {
      ...options,
      // Undefined lets fetchBounded apply the media policy: loopback is only
      // allowed by the test flag outside production (ADJ-02).
      disallowLoopback: options.disallowLoopback,
    });
    return { ok: true, buffer };
  } catch (error) {
    const msg = error?.message ?? String(error);
    if (msg.startsWith('SSRF_') || msg === 'UNTRUSTED_CONTROL_PLANE_ORIGIN') {
      return { ok: false, reason: 'ssrf_blocked', detail: msg };
    }
    return { ok: false, reason: 'download_failed', detail: msg };
  }
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
  lookupImpl,
  disallowLoopback,
} = {}) {
  log(`[media-preloader] downloading image ${urlHash(url)}...`);
  const fetched = await fetchMediaBuffer(url, { fetchImpl, timeoutMs, maxBytes, lookupImpl, disallowLoopback });
  if (!fetched.ok) return fetched;
  const buffer = fetched.buffer;
  const kind = sniffImageKind(buffer);

  if (kind === "svg") {
    // base64 keeps the data URI free of quote/angle characters so it can be
    // spliced straight into an src="..." attribute.
    const dataUri = `data:image/svg+xml;base64,${buffer.toString("base64")}`;
    log(`[media-preloader] inlining SVG as data URI (${buffer.length} bytes)`);
    return { ok: true, dataUri, kind, bytes: buffer.length };
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
  return { ok: true, path: destPath, assetName, kind, bytes: buffer.length };
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
    ffprobeTimeoutMs = 30_000,
    timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    log = () => {},
    spawnImpl = defaultSpawn,
    lookupImpl,
    disallowLoopback,
  } = {}
) {
  mkdirSync(dirname(destPath), { recursive: true });

  log(`[media-preloader] downloading ${urlHash(url)}...`);
  const fetched = await fetchMediaBuffer(url, { fetchImpl, timeoutMs, maxBytes, lookupImpl, disallowLoopback });
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
    const probe = await runFfprobe(ffprobePath, tempPath, spawnImpl, ffprobeTimeoutMs);
    if (!probe.ok) {
      return { ok: false, reason: "ffprobe_failed", detail: probe.error };
    }

    renameSync(tempPath, destPath);
    log(`[media-preloader] validated ${basename(destPath)} (${probe.duration?.toFixed(2) ?? "?"}s)`);
    return { ok: true, path: destPath, bytes: buffer.length, ...probe };
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

function runFfprobe(ffprobePath, filePath, spawnImpl = defaultSpawn, timeoutMs = 30_000) {
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
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      settle({ ok: false, error: `ffprobe timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        settle({ ok: false, error: stderr.trim() || `ffprobe exited ${code}` });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        settle({ ok: true });
        return;
      }
      const format = parsed?.format ?? {};
      const videoStream = (parsed?.streams ?? []).find((s) => s.codec_type === "video");
      const audioStream = (parsed?.streams ?? []).find((s) => s.codec_type === "audio");
      settle({
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
    child.on?.("error", (error) => {
      settle({ ok: false, error: error?.message ?? String(error) });
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
  ffprobeTimeoutMs = 30_000,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  log = () => {},
  spawnImpl = defaultSpawn,
  lookupImpl,
  disallowLoopback,
} = {}) {
  log(`[media-preloader] downloading audio ${urlHash(url)}...`);
  const fetched = await fetchMediaBuffer(url, { fetchImpl, timeoutMs, maxBytes, lookupImpl, disallowLoopback });
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
    const probe = await runFfprobe(ffprobePath, tempPath, spawnImpl, ffprobeTimeoutMs);
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
    return { ok: true, path: destPath, assetName, kind, duration: probe.duration, bytes: buffer.length };
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
async function downloadRawAsset(url, destPath, options = {}) {
  const fetched = await fetchMediaBuffer(url, options);
  if (!fetched.ok) return fetched;
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, fetched.buffer);
  return { ok: true, path: destPath, bytes: fetched.buffer.length };
}

/**
 * Convenience: given an HTML string and a job directory, download and validate
 * all external media, rewrite the HTML, and return diagnostics.
 *
 * Enforces AUD-B03: real attribute parsing, complete resource inventory,
 * unsupported network resources stripped, remaining remote URLs rejected, and
 * a deny-by-default CSP injected. Aggregate byte and time budgets bound the
 * job (ADJ-03).
 *
 * @param {string} html
 * @param {string} jobDir
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.ffprobePath]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxTotalBytes]
 * @param {number} [options.maxTotalTimeMs]
 * @param {string[]} [options.allowedOrigins]
 * @param {(msg: string) => void} [options.log]
 * @param {(command: string, args: string[]) => import('child_process').ChildProcess} [options.spawnImpl]
 * @returns {Promise<{ ok: true, html: string, downloaded: string[], skipped: boolean } | { ok: false, reason: string, failures: Array<{ url: string, reason: string, detail: string }> }>}
 */
export async function prestageExternalMedia(html, jobDir, options = {}) {
  const maxMediaCount = options.maxMediaCount || 128;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const maxTotalTimeMs = options.maxTotalTimeMs ?? 10 * 60_000;
  const deadline = Date.now() + maxTotalTimeMs;

  const stripped = stripUnsupportedRemoteResources(html);
  const workingHtml = stripped.html;
  const urls = extractMediaUrls(workingHtml);
  if (urls.length > maxMediaCount) {
    return {
      ok: false,
      reason: "MEDIA_COUNT_LIMIT",
      failures: [{ reason: "MEDIA_COUNT_LIMIT", detail: "Media count limit exceeded" }],
      outcomes: [],
    };
  }

  const unsupported = urls.filter((entry) => entry.kind === "unsupported");
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: "MEDIA_VALIDATION_FAILED",
      failures: unsupported.map((entry) => ({
        url: maskMediaUrl(entry.originalSrc),
        reason: "unsupported_resource",
        detail: `UNSTAGED_REMOTE_RESOURCE:${entry.tag}:${entry.attribute}`,
      })),
      outcomes: unsupported.map((entry) => ({
        url: maskMediaUrl(entry.originalSrc),
        tag: entry.tag,
        ok: false,
        reason: "unsupported_resource",
      })),
    };
  }

  const assetsDir = join(jobDir, "assets");
  if (urls.length > 0) mkdirSync(assetsDir, { recursive: true });

  const mapping = {};
  const downloaded = [];
  const failures = [];
  // Opção A (F12-voz): resultados por ficheiro com URL mascarada (sem tokens)
  // para a evidence — substitui os logs runtime invisíveis no Coolify.
  const outcomes = [];
  let totalBytes = 0;
  let budgetExceeded = false;

  for (const { tag, originalSrc, kind } of urls) {
    const hash = urlHash(originalSrc);
    const masked = maskMediaUrl(originalSrc);
    const t0 = Date.now();
    const record = (ok, extra = {}) => outcomes.push({ url: masked, tag, ok, ms: Date.now() - t0, ...extra });

    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      budgetExceeded = true;
      failures.push({ url: masked, reason: "MEDIA_TIME_BUDGET_EXCEEDED", detail: "aggregate time budget exhausted" });
      record(false, { reason: "MEDIA_TIME_BUDGET_EXCEEDED" });
      break;
    }
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      budgetExceeded = true;
      failures.push({ url: masked, reason: "MEDIA_BUDGET_EXCEEDED", detail: "aggregate byte budget exhausted" });
      record(false, { reason: "MEDIA_BUDGET_EXCEEDED" });
      break;
    }
    const perFileOptions = {
      ...options,
      timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS, remainingTime)),
      maxBytes: Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, remainingBytes)),
    };

    const failFromResult = (result) => {
      const overBudget = /DOWNLOAD_BYTES_LIMIT/.test(result.detail ?? "")
        && (options.maxBytes ?? DEFAULT_MAX_BYTES) > remainingBytes;
      if (overBudget) budgetExceeded = true;
      const reason = overBudget ? "MEDIA_BUDGET_EXCEEDED" : result.reason;
      failures.push({ url: masked, reason, detail: sanitizeMediaDetail(result.detail) });
      record(false, { reason, detail: sanitizeMediaDetail(result.detail) });
    };

    let result;
    if (kind === "image") {
      // V4-3f.13: images get content-sniffed handling (SVG -> inline data URI,
      // raster -> correct extension).
      result = await downloadAndValidateImage(originalSrc, assetsDir, hash, perFileOptions);
    } else if (kind === "audio") {
      result = await downloadAndValidateAudio(originalSrc, assetsDir, hash, perFileOptions);
    } else if (kind === "track") {
      const ext = /\.vtt$/i.test(originalSrc) ? ".vtt" : /\.srt$/i.test(originalSrc) ? ".srt" : ".txt";
      const assetName = `vp-media-${hash}${ext}`;
      result = await downloadRawAsset(originalSrc, join(assetsDir, assetName), perFileOptions);
      if (result.ok) {
        mapping[originalSrc] = `assets/${assetName}`;
        downloaded.push(originalSrc);
        record(true, { kind: "track" });
      }
    } else {
      const ext = ".mp4"; // we only accept validated mp4 containers
      const assetName = `vp-media-${hash}${ext}`;
      const destPath = join(assetsDir, assetName);
      if (existsSync(destPath)) {
        // Already downloaded in a previous run (e.g. preview -> render reuse).
        mapping[originalSrc] = `assets/${assetName}`;
        downloaded.push(originalSrc);
        record(true, { cached: true });
        continue;
      }
      result = await downloadAndValidateMedia(originalSrc, destPath, perFileOptions);
      if (result.ok) {
        mapping[originalSrc] = `assets/${assetName}`;
        downloaded.push(originalSrc);
        record(true, {});
      }
    }

    if (result?.ok) {
      totalBytes += result.bytes ?? 0;
      if (kind !== "track" && kind !== "video") {
        mapping[originalSrc] = result.dataUri ?? `assets/${result.assetName}`;
        downloaded.push(originalSrc);
        record(true, result.kind ? { kind: result.kind } : {});
      }
      if (totalBytes > maxTotalBytes) {
        budgetExceeded = true;
        failures.push({ url: masked, reason: "MEDIA_BUDGET_EXCEEDED", detail: "aggregate byte budget exceeded" });
        record(false, { reason: "MEDIA_BUDGET_EXCEEDED" });
        break;
      }
    } else if (result && !result.ok) {
      failFromResult(result);
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      reason: budgetExceeded ? "MEDIA_BUDGET_EXCEEDED" : "MEDIA_VALIDATION_FAILED",
      failures,
      outcomes,
    };
  }

  const rewritten = rewriteHtmlMediaUrls(workingHtml, mapping);
  try {
    assertNoRemoteResources(rewritten, { allowedOrigins: options.allowedOrigins ?? [] });
  } catch (error) {
    return {
      ok: false,
      reason: "MEDIA_VALIDATION_FAILED",
      failures: [{ url: "(html)", reason: "remote_resource", detail: error.message }],
      outcomes,
    };
  }

  return {
    ok: true,
    html: hardenCompositionNetwork(rewritten),
    downloaded,
    skipped: urls.length === 0 && stripped.stripped.length === 0,
    outcomes,
    stripped: stripped.stripped,
  };
}
