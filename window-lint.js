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
