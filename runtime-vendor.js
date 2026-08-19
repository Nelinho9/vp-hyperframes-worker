import { createRequire } from "module";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, basename } from "path";

const require = createRequire(import.meta.url);

const RUNTIME_SCRIPT_RE = /(?:@heygen\/hyperframes|@hyperframes\/core|cdn\.hyperframes\.io|hyperframe(?:s)?(?:[.-]runtime|\.min)?\.js)/i;
const GSAP_SCRIPT_RE = /(?:^|[\/@])gsap(?:@|[.\/-]|$)/i;
// Matches fonts.googleapis.com / fonts.gstatic.com references including
// preconnect links (no path) — the trailing slash is optional.
const GOOGLE_FONTS_RE = /https?:\/\/fonts\.(?:googleapis|gstatic)\.com(?:[\/"'\s>]|$)/i;
export const VENDORED_GSAP_ASSET_PATH = "assets/__vp_gsap.min.js";

function resolvePackageFile(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Load browser bundles from installed worker dependencies or the global CLI. */
export function loadVendoredRuntimeBundles() {
  const hyperframesPath = firstExisting([
    process.env.HYPERFRAMES_RUNTIME_PATH,
    resolvePackageFile("hyperframes/dist/hyperframe.runtime.iife.js"),
    resolvePackageFile("@heygen/hyperframes/dist/hyperframe.runtime.iife.js"),
    resolvePackageFile("@hyperframes/core/dist/hyperframe.runtime.iife.js"),
    "/usr/local/lib/node_modules/hyperframes/dist/hyperframe.runtime.iife.js",
  ]);
  const gsapPath = firstExisting([
    process.env.GSAP_RUNTIME_PATH,
    resolvePackageFile("gsap/dist/gsap.min.js"),
    "/usr/local/lib/node_modules/gsap/dist/gsap.min.js",
  ]);

  return {
    hyperframes: hyperframesPath ? readFileSync(hyperframesPath, "utf8") : "",
    gsap: gsapPath ? readFileSync(gsapPath, "utf8") : "",
    hyperframesPath,
    gsapPath,
  };
}

function scriptSrc(tag) {
  const match = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function isRuntimeScript(tag) {
  const src = scriptSrc(tag);
  return Boolean(src && (RUNTIME_SCRIPT_RE.test(src) || GSAP_SCRIPT_RE.test(src)));
}

function escapeInlineScript(bundle) {
  return String(bundle).replace(/<\/script/gi, "<\\/script");
}

/** Remove CDN/font references and inline deterministic browser bundles.
 *
 * `fontFaceStyle` (V4-3f.10): the sanitizer strips Google Fonts references,
 * which hyperframes lint's `font_family_without_font_face` rule uses to
 * exempt brand families — removing them without replacement made every
 * brand font a hard lint error. Callers must pass the replacement
 * `<style>` block produced by prepareOfflineFonts().
 */
export function sanitizeCompositionForOffline(html, {
  hyperframesRuntime = "",
  gsapRuntime = "",
  gsapSrc = VENDORED_GSAP_ASSET_PATH,
  fontFaceStyle = "",
} = {}) {
  if (typeof html !== "string") return html;

  let sanitized = html
    .replace(/<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => (
      isRuntimeScript(tag) ? "" : tag
    ))
    .replace(/<link\b[^>]*\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, (tag) => (
      GOOGLE_FONTS_RE.test(tag) ? "" : tag
    ))
    .replace(/@import\s+(?:url\(\s*)?["']?https?:\/\/fonts\.(?:googleapis|gstatic)\.com[^;\n)"']+["']?\s*\)?\s*;?/gi, "");

  // The HyperFrames CLI injects its own installed runtime at /runtime.js during
  // lint/check/render. Embedding that bundle here makes the linter inspect the
  // library source as composition code. Keep GSAP as a local project asset for
  // the same reason: it is loaded by Chromium from disk but never linted as an
  // inline script. `hyperframesRuntime` is intentionally accepted for callers
  // that already load both bundles, but is not embedded into the composition.
  const localScripts = [];
  if (fontFaceStyle) localScripts.push(fontFaceStyle);
  if (gsapRuntime) {
    const safeSrc = String(gsapSrc || VENDORED_GSAP_ASSET_PATH).replace(/["<>]/g, "");
    localScripts.push(`<script data-vp-vendored="gsap" src="${safeSrc}"></script>`);
  }
  if (localScripts.length === 0) return sanitized;

  const block = `${localScripts.join("\n")}\n`;
  if (/<\/head\s*>/i.test(sanitized)) return sanitized.replace(/<\/head\s*>/i, `${block}</head>`);
  return `${block}${sanitized}`;
}

// ── Offline font resolution (V4-3f.10) ─────────────────────────────
// Brand fonts arrive as Google Fonts <link>/@import URLs. The sanitizer
// must strip them (no CDN at render time), but lint requires every used
// family to have an @font-face declaration. prepareOfflineFonts()
// resolves the real woff2 files into local assets; when the network is
// unavailable it falls back to src: local() declarations, which the
// lint fixHint explicitly accepts.

function normalizeFontFamily(raw) {
  return String(raw || "")
    .replace(/\+/g, " ")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

/** Family names referenced by Google Fonts links/@imports in the HTML. */
export function extractGoogleFontFamilies(html) {
  if (typeof html !== "string") return [];
  const families = new Set();
  const specs = extractGoogleFontSpecs(html);
  for (const spec of specs) {
    for (const part of decodeURIComponent(spec).split("|")) {
      const family = normalizeFontFamily(part.split(":")[0]);
      if (family) families.add(family);
    }
  }
  return [...families];
}

/** Raw `family=` specs (weights/axes preserved) from css2 URLs in the HTML. */
export function extractGoogleFontSpecs(html) {
  if (typeof html !== "string") return [];
  const specs = [];
  const seen = new Set();
  const urlRe = /https?:\/\/fonts\.googleapis\.com\/css2?\?[^\s"'<>)]+/gi;
  for (const match of html.matchAll(urlRe)) {
    for (const spec of match[0].matchAll(/[?&]family=([^&\s"'<>)]+)/g)) {
      if (!seen.has(spec[1])) {
        seen.add(spec[1]);
        specs.push(spec[1]);
      }
    }
  }
  return specs;
}

/** Lint-satisfying fallback: @font-face with local() sources only. */
export function localFontFaceStyle(families) {
  const list = Array.isArray(families) ? families.filter(Boolean) : [];
  if (list.length === 0) return "";
  const blocks = list.map((family) => {
    const safe = String(family).replace(/[\\"]/g, "");
    return `@font-face{font-family:'${safe}';font-style:normal;font-weight:100 900;src:local('${safe}');font-display:swap;}`;
  });
  return `<style data-vp-fonts="local">${blocks.join("")}</style>`;
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

// css2 responses group @font-face blocks under a `/* subset */` comment.
// Only the latin subset is needed for PT/EN copy (U+0000–00FF coverage).
function parseCss2LatinFaces(css) {
  const faces = [];
  const chunks = String(css).split(/\/\*\s*([a-z0-9-]+)\s*\*\//gi);
  // chunks: [pre, subset1, css1, subset2, css2, ...]
  for (let i = 1; i + 1 < chunks.length; i += 2) {
    const subset = chunks[i].toLowerCase();
    if (subset !== "latin") continue;
    for (const block of chunks[i + 1].matchAll(/@font-face\s*\{[^}]*\}/g)) {
      const body = block[0];
      const urlMatch = body.match(/src\s*:\s*url\(\s*(https:\/\/fonts\.gstatic\.com\/[^)\s]+)/i);
      const weightMatch = body.match(/font-weight\s*:\s*([^;]+);/i);
      const styleMatch = body.match(/font-style\s*:\s*([^;]+);/i);
      const familyMatch = body.match(/font-family\s*:\s*([^;]+);/i);
      if (!urlMatch) continue;
      faces.push({
        url: urlMatch[1],
        weight: (weightMatch?.[1] || "400").trim(),
        style: (styleMatch?.[1] || "normal").trim(),
        family: (familyMatch?.[1] || "").trim().replace(/^['"]|['"]$/g, ""),
      });
    }
  }
  return faces;
}

/**
 * @typedef {object} PrepareOfflineFontsOptions
 * @property {string} jobDir Job directory (assets/ receives the woff2 files).
 * @property {string} [cacheDir] Shared font cache across jobs.
 * @property {(url: string, init?: unknown) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, arrayBuffer: () => Promise<ArrayBuffer> }>} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {(message: string) => void} [log]
 */

/**
 * Resolve Google Fonts used by the composition into local woff2 assets.
 *
 * Returns `{ style }` — a `<style data-vp-fonts>` block with @font-face
 * declarations pointing at `assets/vp-font-*.woff2` files written into
 * `jobDir/assets/` (served by the preview asset route), or local()-only
 * fallback declarations when resolution fails. Never throws.
 *
 * @param {string} html
 * @param {PrepareOfflineFontsOptions} [options]
 */
export async function prepareOfflineFonts(html, {
  jobDir,
  cacheDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  log = () => {},
} = {}) {
  const families = extractGoogleFontFamilies(html);
  if (families.length === 0) return { style: "", families };

  const specs = extractGoogleFontSpecs(html);
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const faces = [];
  const assetsDir = join(jobDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  try {
    for (const spec of specs) {
      const cssUrl = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
      const cssRes = await fetchWithTimeout(fetchImpl, cssUrl, { timeoutMs, headers: { "user-agent": ua } });
      if (!cssRes.ok) throw new Error(`css2 ${cssRes.status}`);
      const latin = parseCss2LatinFaces(await cssRes.text());
      for (const face of latin) {
        const hash = sha1(face.url);
        const assetName = `vp-font-${hash}.woff2`;
        const assetPath = join(assetsDir, assetName);
        if (!existsSync(assetPath)) {
          const cachePath = cacheDir ? join(cacheDir, assetName) : null;
          if (cachePath && existsSync(cachePath)) {
            copyFileSync(cachePath, assetPath);
          } else {
            const fontRes = await fetchWithTimeout(fetchImpl, face.url, { timeoutMs, headers: { "user-agent": ua } });
            if (!fontRes.ok) throw new Error(`woff2 ${fontRes.status}`);
            const buf = Buffer.from(await fontRes.arrayBuffer());
            if (cachePath) {
              mkdirSync(cacheDir, { recursive: true });
              writeFileSync(cachePath, buf);
            }
            writeFileSync(assetPath, buf);
          }
        }
        faces.push({ ...face, src: `assets/${assetName}` });
      }
    }
  } catch (err) {
    log(`[worker] offline font resolution failed (${err?.message ?? err}) — using local() fallback`);
    return { style: localFontFaceStyle(families), families };
  }

  if (faces.length === 0) return { style: localFontFaceStyle(families), families };

  // css2 responses carry the exact family name per @font-face block —
  // keep it (normalized) so declarations match the composition's usage.
  const named = faces.map((face) => {
    const family = (face.family && normalizeFontFamily(face.family)) || families[0];
    const safe = String(family).replace(/[\\"]/g, "");
    return `@font-face{font-family:'${safe}';font-display:swap;font-style:${face.style};font-weight:${face.weight};src:url('${face.src}') format('woff2');}`;
  });
  return { style: `<style data-vp-fonts="resolved">${named.join("")}</style>`, families };
}

function findingList(section) {
  if (!section || typeof section !== "object") return [];
  const value = section.findings ?? section.errors ?? [];
  return Array.isArray(value) ? value : [];
}

function sectionIsOk(section) {
  if (!section || typeof section !== "object") return false;
  return section.ok !== false && findingList(section).every((finding) => finding?.severity !== "error");
}

function findingUrl(finding) {
  if (typeof finding?.url === "string") return finding.url;
  const match = typeof finding?.message === "string" ? finding.message.match(/https?:\/\/[^\s'"<>]+/i) : null;
  return match?.[0] ?? "";
}

function isTolerableNetworkFinding(finding) {
  const code = String(finding?.code ?? "").toLowerCase();
  if (code !== "request_failed" && code !== "http_error") return false;
  return /^https?:\/\//i.test(findingUrl(finding));
}

/** Classify a HyperFrames --json check envelope without hiding JS errors. */
export function classifyCheckEnvelope(envelope) {
  const lint = envelope?.lint;
  const layout = envelope?.layout;
  const runtime = envelope?.runtime;
  const runtimeFindings = [
    ...findingList(runtime),
    ...(Array.isArray(envelope?.runtimeFindings) ? envelope.runtimeFindings : []),
  ];
  const tolerated = runtimeFindings.filter((finding) => finding?.severity === "error" && isTolerableNetworkFinding(finding));
  const fatal = runtimeFindings.filter((finding) => finding?.severity === "error" && !isTolerableNetworkFinding(finding));
  const lintOk = sectionIsOk(lint);
  const layoutOk = sectionIsOk(layout);
  const runtimeUnknownFailure = Boolean(runtime && runtime.ok === false && runtimeFindings.length === 0);

  return {
    ok: lintOk && layoutOk && fatal.length === 0 && !runtimeUnknownFailure,
    lintOk,
    layoutOk,
    tolerated,
    fatal: runtimeUnknownFailure ? [{ code: "runtime_unknown_failure", severity: "error", message: "HyperFrames reported an unknown runtime failure" }, ...fatal] : fatal,
    warnings: [
      ...tolerated,
      ...runtimeFindings.filter((finding) => finding?.severity === "warning" || finding?.severity === "info"),
    ],
  };
}

function tryParseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Extract the first balanced JSON object from CLI output with log chatter. */
export function extractCheckJson(output) {
  if (output && typeof output === "object") return output;
  const text = String(output ?? "").trim();
  if (!text) return null;
  const direct = tryParseJson(text);
  if (direct) return direct;

  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJson(text.slice(start, i + 1));
          if (parsed && (parsed.lint || parsed.layout || parsed.runtime || parsed.ok !== undefined)) return parsed;
          break;
        }
      }
    }
  }
  return null;
}
