/**
 * window-lint — V5-P0C §2.2 (V5-P2C §2.6): worker-side validation of clip
 * timeline windows.
 *
 * The HyperFrames CLI lint runs later in the render pipeline, but the seek
 * determinism invariant needs a gate AT THE PERSISTENCE LAYER (right where
 * `/restructure` and `/job` staging rewrite windows). Findings use the same
 * shape as CLI findings: `{code, severity, message?, selector?}`.
 *
 * Rules (top-level `.clip`s only — the composition root and any element
 * carrying `data-composition-id` live on their own timeline and are exempt):
 *   - `clip_window_overlap` (error):   start_{i+1} < end_i  → two scenes
 *     visible at once (the B2 flicker signature). V5-P2C: a declared
 *     transition (`data-transition-in` on the incoming clip / `-out` on the
 *     outgoing one) exempts an overlap UP TO its clamped duration; anything
 *     beyond stays an error.
 *   - `clip_window_gap`     (warning): start_{i+1} > end_i  → blank flash.
 *   - `gsap_target_missing` (warning, via `lintGsapTargets`): a GSAP tween
 *     call (`.fromTo`/`.from`/`.to`/`.set` with tween vars) addresses a
 *     selector that resolves to zero elements — V5.21 Fase H (the
 *     `#scene-5-tick` orphan-tween class: the runtime logs
 *     `GSAP target ... not found` and skips the tween). Warn-only by design:
 *     report-only until the corpus is calibrated, never a hard fail.
 *
 * Windows are compared as parsed doubles, exactly like the runtime evaluates
 * them — no quantization happens here (that is `normalizeClipWindows`' job).
 */

import { parseHTML } from "linkedom";
import { parseTransitionAttr } from "./transition-presets.js";

/** Tolerance for double round-off when comparing overlap vs allowed (s). */
const OVERLAP_EPS = 1e-9;

/**
 * Allowed overlap between two adjacent clips from their transition
 * attributes, in seconds (null when neither declares a transition).
 */
function allowedOverlapSeconds(prevEl, el) {
  const out = parseTransitionAttr(prevEl?.getAttribute("data-transition-out"));
  const incoming = parseTransitionAttr(el.getAttribute("data-transition-in"));
  const ms = Math.max(out?.durationMs ?? 0, incoming?.durationMs ?? 0);
  return ms > 0 ? ms / 1000 : null;
}

/**
 * Validate the served composition HTML for overlapping/gapping clip windows.
 *
 * @param {string} html Composition HTML.
 * @param {{ fps?: number }} [opts] fps is accepted for parity with the other
 *        window helpers (findings are computed from raw seconds).
 * @returns {Array<{code: string, severity: string, selector?: string, message?: string}>}
 */
export function lintClipWindows(html, opts = {}) {
  void opts?.fps;
  const findings = [];
  if (typeof html !== "string" || html.length === 0) return findings;

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return findings;
  }

  // Root-sequence clips only: owned by THE composition root (or orphaned) —
  // never by a nested composition, whose clips live on their own timeline.
  const rootEl = document.querySelector("[data-composition-id]");
  const clips = Array.from(document.querySelectorAll(".clip")).filter((el) => {
    const owner = el.closest("[data-composition-id]");
    return owner === null || owner === rootEl;
  });

  let prev = null; // { el, end, selector }
  for (const el of clips) {
    const start = parseFloat(el.getAttribute("data-start"));
    const duration = parseFloat(el.getAttribute("data-duration"));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
      continue; // unusable window — out of scope for this rule
    }
    const end = start + duration;
    const id = el.id || el.getAttribute("data-hf-id") || "";
    const selector = id ? `#${id}` : ".clip";

    if (prev) {
      if (start < prev.end) {
        const allowed = allowedOverlapSeconds(prev.el, el);
        const actual = prev.end - start;
        if (allowed == null || actual > allowed + OVERLAP_EPS) {
          findings.push({
            code: "clip_window_overlap",
            severity: "error",
            selector,
            message:
              allowed == null
                ? `clip window starts at ${start}s, before previous clip "${prev.selector}" ends at ${prev.end}s`
                : `transition overlap ${(actual).toFixed(3)}s exceeds the declared ${allowed.toFixed(3)}s after "${prev.selector}"`,
          });
        }
      } else if (start > prev.end) {
        findings.push({
          code: "clip_window_gap",
          severity: "warning",
          selector,
          message: `${(start - prev.end).toFixed(3)}s gap after previous clip "${prev.selector}"`,
        });
      }
    }
    prev = { el, end, selector };
  }

  return findings;
}

// ─── V5.21 Fase H: gsap_target_missing (warn, report-only) ─────────────────
// Orphan-tween class (§2.7: a legacy inline tween addressing `#scene-5-tick
// path` whose element no longer exists — GSAP warns `target not found` at
// runtime while the materialized data-anim appliers skip silently). Scans
// inline <script> blocks for GSAP tween calls whose FIRST argument is a
// string selector and reports selectors resolving to zero elements.
//
// Anti-false-positive guards (warn must stay quiet on the known-good corpus):
//   - only `.fromTo`/`.from`/`.to`/`.set` calls whose args region carries a
//     tween-vars key (`duration:`/`ease:`/`opacity:`/…) count — plain
//     `Map.set("key", v)` and friends are ignored;
//   - element-ref calls (`tl.fromTo(el, …)` — what the materialized
//     data-anim/data-kf/transition blocks emit) have no string first arg and
//     are ignored by construction;
//   - selectors the DOM engine cannot parse throw → skipped, never flagged;
//   - findings capped at MAX_GSAP_TARGET_FINDINGS.

/** Cap for gsap_target_missing findings per document (parity: edgeLint.ts). */
export const MAX_GSAP_TARGET_FINDINGS = 5;

/**
 * Tween-vars keys proving a `.to`/`.from`/`.fromTo`/`.set` call is a GSAP
 * tween (vs `Map.set`, `WeakMap.set`, …). MUST stay in sync with the mirror
 * in `supabase/functions/video-v4-steps/edgeLint.ts` (V5.21 Fase H parity).
 */
const TWEEN_VARS_RE =
  /\b(duration|ease|delay|opacity|x|y|scale|rotation|repeat|stagger|paused|onComplete|onUpdate|onStart|startAt|yoyo|repeatDelay|motionPath|scrollTrigger|keyframes)\s*:/;

/** Locate tween call spans — same string-aware scan as composition-sanitizer. */
function gsapTweenCallSpans(script) {
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

/** Leading string literal of an args region (the tween target), if any. */
function firstStringArg(argsText) {
  const m = /^\s*(['"])((?:\\\1|(?!\1)[\s\S])*)\1/.exec(argsText);
  return m ? m[2] : null;
}

/**
 * Validate GSAP tween selectors in the served composition HTML.
 *
 * @param {string} html Composition HTML.
 * @returns {Array<{code: string, severity: string, selector?: string, message?: string}>}
 *          warn-level `gsap_target_missing` findings (never errors).
 */
export function lintGsapTargets(html) {
  const findings = [];
  if (typeof html !== "string" || html.length === 0) return findings;

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return findings;
  }

  const scripts = Array.from(document.querySelectorAll("script"))
    .filter((s) => !s.getAttribute("src"))
    .map((s) => s.textContent ?? "");
  if (scripts.length === 0) return findings;

  const seen = new Set();
  for (const script of scripts) {
    for (const { argsStart, end } of gsapTweenCallSpans(script)) {
      const args = script.slice(argsStart, Math.max(argsStart, end - 1));
      const target = firstStringArg(args);
      if (target == null) continue; // element ref / variable — not a selector
      if (!TWEEN_VARS_RE.test(args)) continue; // not a tween (Map.set et al.)
      for (const part of target.split(",")) {
        const sel = part.trim();
        if (!sel || seen.has(sel)) continue;
        seen.add(sel);
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch {
          continue; // unparseable selector — never flag (no false positives)
        }
        if (!el && findings.length < MAX_GSAP_TARGET_FINDINGS) {
          findings.push({
            code: "gsap_target_missing",
            severity: "warning",
            selector: sel,
            message: `GSAP tween targets no element: "${sel}" resolves to zero elements (GSAP logs "target not found" and skips it). Fix hint: restore the element with this id or re-point the tween at the current id.`,
          });
        }
      }
    }
  }

  return findings;
}
