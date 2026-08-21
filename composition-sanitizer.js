/**
 * composition-sanitizer.js — V4-3f.17 (V4_3F_16_INCIDENT Fase 5)
 *
 * Worker-side tolerance layer, mirroring the edge-side repair
 * (supabase/functions/video-v4-steps/edgeLint.ts):
 *
 * 1. sanitizeCompositionTweens — mechanical rewrite of GSAP tweens that use
 *    layout properties (`left`/`top`) into their transform equivalents
 *    (`x`/`y`) BEFORE `hyperframes lint` runs. This is the exact error class
 *    (gsap_non_transform_motion on #laser-scan) that hard-failed the
 *    V4-3f.16 build on the worker. width/height/margin/padding are NOT
 *    renamed — those conversions are context-dependent and remain lint
 *    errors for the edge retry loop to fix.
 *
 * 2. extractLintFindings — parses the `hyperframes lint --json` output from
 *    a failed execSync (stdout/stderr) into the structured findings array so
 *    the orchestrator callback carries the full list instead of a truncated
 *    "Command failed" message.
 *
 * Pure functions, no I/O — testable under vitest (worker-sanitize.test.ts).
 */

const TWEEN_KEY_RENAME = { left: "x", top: "y" };

/**
 * Locate tween call spans (.fromTo/.from/.to/.set) inside a script body.
 * String-aware bracket scan: parens inside string literals do not break the
 * argument extraction.
 */
function tweenCallSpans(script) {
  const spans = [];
  const callRe = /\.(fromTo|from|to|set)\s*\(/g;
  let m;
  while ((m = callRe.exec(script)) !== null) {
    const argsStart = m.index + m[0].length;
    let depth = 1;
    let i = argsStart;
    let inStr = null;
    while (i < script.length && depth > 0) {
      const c = script[i];
      if (inStr) {
        if (c === "\\") i += 1;
        else if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === "`") {
        inStr = c;
      } else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    spans.push({ callStart: m.index, argsStart, end: i });
  }
  return spans;
}

/** First quoted string inside the args region (best-effort selector). */
function callSelector(argsText) {
  const m = argsText.match(/["']([^"']*)["']/);
  return m ? m[1] : "(unknown)";
}

/**
 * Rename left/top object keys inside one call span, skipping string
 * literals. Records each rename in `repairs` as `selector: prop->replacement`.
 */
function renameTweenKeys(segment, selector, repairs) {
  let out = "";
  let i = 0;
  let inStr = null;
  while (i < segment.length) {
    const c = segment[i];
    if (inStr) {
      if (c === "\\") {
        out += segment.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      out += c;
      i += 1;
      continue;
    }
    const m = /^(left|top)(\s*:)/.exec(segment.slice(i));
    if (m) {
      // Only rename object keys (preceded by `{`, `,` or segment start).
      let p = out.length - 1;
      while (p >= 0 && /\s/.test(out[p])) p -= 1;
      const prev = p >= 0 ? out[p] : "";
      if (prev === "{" || prev === "," || prev === "") {
        repairs.push(`${selector}: ${m[1]}->${TWEEN_KEY_RENAME[m[1]]}`);
        out += TWEEN_KEY_RENAME[m[1]] + m[2];
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function sanitizeScriptTweens(script, repairs) {
  const spans = tweenCallSpans(script);
  if (spans.length === 0) return { text: script, changed: false };
  let out = "";
  let cursor = 0;
  let changed = false;
  for (const { callStart, argsStart, end } of spans) {
    if (callStart < cursor) continue; // nested/overlapping — already covered
    const spanText = script.slice(callStart, end);
    const renamed = renameTweenKeys(spanText, callSelector(script.slice(argsStart, end)), repairs);
    if (renamed !== spanText) changed = true;
    out += script.slice(cursor, callStart) + renamed;
    cursor = end;
  }
  out += script.slice(cursor);
  return { text: out, changed };
}

/**
 * Sanitize every inline <script> block in the composition HTML.
 * Returns `{ html, repairs }` where `repairs` is a human-readable list of
 * the mechanical conversions applied (for worker logs / diagnostics).
 */
export function sanitizeCompositionTweens(html) {
  const repairs = [];
  const source = String(html ?? "");
  const out = source.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (full, attrs, body) => {
      if (/\bsrc\s*=/i.test(attrs)) return full; // external script — never touch
      const { text, changed } = sanitizeScriptTweens(body, repairs);
      return changed ? `<script${attrs}>${text}</script>` : full;
    }
  );
  return { html: out, repairs };
}

/**
 * Extract the structured findings array from a failed
 * `execSync("npx hyperframes lint --json ...")` error. Handles the JSON
 * document as a bare array, a `{ findings: [...] }` envelope, or JSON
 * embedded in CLI chatter. Returns null when nothing parseable exists.
 */
export function extractLintFindings(err) {
  const streams = [err?.stdout, err?.stderr]
    .map((b) => (b ? b.toString() : ""))
    .filter((s) => s.trim());
  for (const raw of streams) {
    // Scan for JSON documents starting at each `{`/`[` occurrence.
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i];
      if (c !== "{" && c !== "[") continue;
      const candidate = raw.slice(i);
      let parsed = null;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        // Try cutting at the last matching closer (JSON embedded in chatter).
        const closer = c === "{" ? "}" : "]";
        const lastIdx = candidate.lastIndexOf(closer);
        if (lastIdx > 0) {
          try {
            parsed = JSON.parse(candidate.slice(0, lastIdx + 1));
          } catch {
            parsed = null;
          }
        }
      }
      if (parsed) {
        const list = Array.isArray(parsed) ? parsed : parsed.findings;
        if (Array.isArray(list) && list.some((f) => f && typeof f.code === "string")) {
          return list.filter((f) => f && typeof f.code === "string");
        }
      }
    }
  }
  return null;
}
