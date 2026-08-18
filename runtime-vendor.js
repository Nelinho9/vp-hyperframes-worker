import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";

const require = createRequire(import.meta.url);

const RUNTIME_SCRIPT_RE = /(?:@heygen\/hyperframes|@hyperframes\/core|cdn\.hyperframes\.io|hyperframe(?:s)?(?:[.-]runtime|\.min)?\.js)/i;
const GSAP_SCRIPT_RE = /(?:^|[\/@])gsap(?:@|[.\/-]|$)/i;
const GOOGLE_FONTS_RE = /https?:\/\/fonts\.(?:googleapis|gstatic)\.com\//i;

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

/** Remove CDN/font references and inline deterministic browser bundles. */
export function sanitizeCompositionForOffline(html, {
  hyperframesRuntime = "",
  gsapRuntime = "",
} = {}) {
  if (typeof html !== "string") return html;

  let sanitized = html
    .replace(/<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => (
      isRuntimeScript(tag) ? "" : tag
    ))
    .replace(/<link\b[^>]*\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, (tag) => (
      GOOGLE_FONTS_RE.test(tag) ? "" : tag
    ))
    .replace(/@import\s+(?:url\(\s*)?["']?https?:\/\/fonts\.(?:googleapis|gstatic)\.com\/[^;\n)"']+["']?\s*\)?\s*;?/gi, "");

  const inline = [];
  if (gsapRuntime) inline.push(`<script data-vp-vendored="gsap">${escapeInlineScript(gsapRuntime)}</script>`);
  if (hyperframesRuntime) inline.push(`<script data-vp-vendored="hyperframes">${escapeInlineScript(hyperframesRuntime)}</script>`);
  if (inline.length === 0) return sanitized;

  const block = `${inline.join("\n")}\n`;
  if (/<\/head\s*>/i.test(sanitized)) return sanitized.replace(/<\/head\s*>/i, `${block}</head>`);
  return `${block}${sanitized}`;
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
