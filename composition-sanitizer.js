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
 * V5.27 Fase D — timeline-registry repair pré-lint (job 1700b4f4).
 *
 * Paridade com a regra `gsap_timeline_not_registered` do CLI 0.7.109
 * (cli.js:82941-82945) e com o repair intra-script da edge (Fase A,
 * `repairTimelineRegistry` em
 * `visttapro/supabase/functions/video-v4-steps/edgeLint.ts`): cada bloco
 * `<script>` inline que CRIA uma timeline (`gsap.timeline`) sem o registro
 * canônico NO MESMO BLOCO ganha, logo após o statement de criação:
 *
 *   window.__timelines = window.__timelines || {};
 *   window.__timelines["<compositionId>"] = <identificador>;
 *
 * onde o RHS é obrigatoriamente um identificador (cli.js:81717) — a forma
 * ternária antiga (`= (typeof gsap !== "undefined") ? …`) nunca casava e o
 * bloco injetado virava um offender adicional.
 *
 * Idempotente (blocos canônicos nunca tocados), no máximo 1 inserção por
 * script ofensor. Um bloco cujo identificador não é extraível com confiança
 * NÃO é mutado (o lint real reporta; sem magia). Sem fallback canônico: ao
 * contrário da edge, o worker nunca inventa uma timeline quando nenhuma
 * existe — só repara ofensores reais.
 */

const WINDOW_TIMELINE_ASSIGN_PATTERN =
  /window\.__timelines(?:\[\s*(?:["']([^"']+)["']|[A-Za-z_$][\w$.]*)\s*\]|\.\s*([A-Za-z_$][\w$]*))\s*=\s*([A-Za-z_$][\w$]*)/i;

const TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN =
  /window\.__timelines\s*=\s*\{\s*(?:["'][^"']+["']|[A-Za-z_$][\w$]*)\s*:/i;

/**
 * CLI parity (cli.js:82943-82945): true when a script block CREATES a GSAP
 * timeline but carries no canonical registration in the SAME block.
 */
function scriptCreatesUnregisteredTimeline(script) {
  if (!/gsap\.timeline/.test(script)) return false;
  return !(
    WINDOW_TIMELINE_ASSIGN_PATTERN.test(script)
    || TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN.test(script)
  );
}

/** Index right after the `)` matching the `(` at `argsStart` (string-aware). */
function matchTimelineParenEnd(source, argsStart) {
  let depth = 1;
  let i = argsStart;
  let str = null;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (str) {
      if (c === "\\") i += 1;
      else if (c === str) str = null;
    } else if (c === '"' || c === "'" || c === "`") {
      str = c;
    } else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    i += 1;
  }
  return i;
}

/** Remove JS line/block comments before reasoning about a statement segment. */
function stripTimelineJsComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n\r]*/g, "$1 ");
}

/**
 * Identifier assigned to the timeline creation at `callStart`:
 * `const tl = ` → "tl"; `tl = ` → "tl"; `window.tl = ` → "window.tl".
 * Returns null for anything not confidently an assignment.
 */
function timelineAssignedIdentifier(content, callStart) {
  const before = content.slice(0, callStart);
  const m = /(?:^|[;{}\n\r])\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*=\s*$/
    .exec(before);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

/**
 * Boundary right after the statement that owns the creation call (its first
 * top-level `;`), or the index of the enclosing `}` — so the registration is
 * spliced WITHOUT splitting a chained `gsap.timeline({...}).fromTo(...)`
 * expression. Returns null when no safe boundary exists or the segment would
 * land after a control-flow exit (`return`/`throw`/`break`/`continue`).
 */
function timelineRegistrationIndex(content, callEnd) {
  let i = callEnd;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let str = null;
  let boundary = null;
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];
    if (str) {
      if (c === "\\") { i += 2; continue; }
      if (c === str) str = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      const nl = content.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = content.indexOf("*/", i + 2);
      if (close < 0) break;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; i += 1; continue; }
    if (c === "(") parens += 1;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (c === "[") brackets += 1;
    else if (c === "]") brackets = Math.max(0, brackets - 1);
    else if (c === "{") braces += 1;
    else if (c === "}") {
      if (parens === 0 && brackets === 0 && braces === 0) { boundary = i; break; }
      braces = Math.max(0, braces - 1);
    } else if (c === ";" && parens === 0 && brackets === 0 && braces === 0) {
      boundary = i + 1;
      break;
    }
    i += 1;
  }
  if (boundary === null) return null;
  const segment = stripTimelineJsComments(content.slice(callEnd, boundary));
  if (/\b(?:return|throw|break|continue)\b/.test(segment)) return null;
  return boundary;
}

/**
 * Register every unregistered timeline INSIDE the script block that creates
 * it. Returns `{ html, repairs }` where `repairs` is a human-readable list
 * of the insertions applied (for worker logs / diagnostics — same pattern
 * as `sanitizeCompositionTweens`).
 *
 * @param {string} html composition HTML
 * @param {string} [compositionId] registry key (defaults to "main")
 */
export function sanitizeTimelineRegistry(html, compositionId = "main") {
  const repairs = [];
  const source = String(html ?? "");
  const key = /^[\w-]+$/.test(String(compositionId ?? "")) ? String(compositionId) : "main";
  let scriptIndex = 0;
  const out = source.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (full, attrs, content) => {
      scriptIndex += 1;
      if (/\bsrc\s*=/i.test(attrs)) return full;
      if (!scriptCreatesUnregisteredTimeline(content)) return full;
      const call = /\bgsap\s*\.\s*timeline\s*\(/.exec(content);
      if (!call) return full;
      const identifier = timelineAssignedIdentifier(content, call.index);
      if (!identifier) return full;
      const callEnd = matchTimelineParenEnd(content, call.index + call[0].length);
      const insertAt = timelineRegistrationIndex(content, callEnd);
      if (insertAt === null) return full;
      const lineStart = content.lastIndexOf("\n", call.index) + 1;
      const indent = /^[ \t]*/.exec(content.slice(lineStart, call.index))?.[0] ?? "";
      const registration =
        `${indent}window.__timelines = window.__timelines || {};\n`
        + `${indent}window.__timelines["${key}"] = ${identifier};`;
      repairs.push(`script#${scriptIndex}: registered "${identifier}" as "${key}"`);
      return `<script${attrs}>${content.slice(0, insertAt)}\n${registration}\n${content.slice(insertAt)}</script>`;
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
