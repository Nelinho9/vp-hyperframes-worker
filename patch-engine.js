/**
 * patch-engine — V4-04C: linkedom-backed HTML patch + timeline restructure
 *
 * Shared semantics with src/video/v4/patchHtml.ts via the V5-P0B canonical
 * table (`prop-map.js`, mirrored in the app as `src/video/v4/propMap.ts`;
 * parity enforced byte-a-byte by tests in BOTH repos):
 *   - `textContent` → textContent
 *   - `src`         → attribute
 *   - `background-image` → wrap `url(...)`
 *   - decl props (font/size/weight/color/opacity) → mapped CSS property
 *   - GEOMETRY (x/y/width/height/rotation) → AD-1: `--el-*` custom properties
 *     consumed by individual transforms / layout vars on the same element.
 *     x/y values are ABSOLUTE composition coordinates converted to a translate
 *     DELTA against the authored inline `left/top` baseline — the engine never
 *     writes `left/top` literals (B1.3 fix).
 *
 * Patches target `#id` selectors ONLY (400 from the routes otherwise) —
 * arbitrary selectors would let an authenticated user rewrite the runtime
 * scripts of a composition.
 *
 * `applyTimelineRestructure` rewrites the composition deterministically from
 * an editor timeline: per-clip data-duration = durationFrames/fps, data-start
 * recomputed cumulatively, clips whose id vanished are removed, and the root
 * data-duration becomes the new total.
 *
 * V5-P0C (seek determinism): every window written here (and by
 * `normalizeClipWindows` at job staging) is quantized to the fps frame grid
 * with FLOAT-EXACT contiguous boundaries — for each integer frame tick,
 * exactly one clip window contains it (B2 fix). `window-lint.js` validates
 * the invariant after every write.
 */

import { parseHTML } from "linkedom";
import { PROP_MAP, GEOM_CONSUMPTION, computeGeomDelta } from "./prop-map.js";

/** Numeric CSS value (px/deg candidates) — integers, decimals and negatives. */
const NUMERIC_VALUE_RE = /^-?\d+(\.\d+)?$/;

/** Decl props that still get a px unit appended to bare numbers. */
const DECL_NUMERIC_PROPS = new Set([
  "font-size", "margin", "padding", "border-width",
]);

function addDeclUnit(cssProp, value) {
  if (DECL_NUMERIC_PROPS.has(cssProp) && NUMERIC_VALUE_RE.test(value)) {
    return `${value}px`;
  }
  return value;
}

/** Extract one authored declaration value from a style attribute string. */
export function parseInlineDecl(styleAttr, prop) {
  if (!styleAttr) return null;
  const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]*)`, "i");
  const m = styleAttr.match(re);
  return m ? m[2].trim() : null;
}

/** Authored px baseline for translate deltas (missing/auto/non-numeric → 0). */
function authoredOffsetPx(styleAttr, prop) {
  const raw = parseInlineDecl(styleAttr, prop);
  if (!raw) return 0;
  const n = parseFloat(raw); // '340px' → 340 · 'auto'/'' → NaN → 0
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apply one geometry patch (V5-P0B / AD-1): write the `--el-*` var (+ unit
 * for numeric values; non-numeric pass verbatim without delta math) plus its
 * consumption declaration on the SAME element. x/y deltas are computed
 * against the authored inline left/top so the persisted HTML reproduces the
 * preview exactly while keeping the authored origin untouched.
 */
function applyGeometryPatch(el, property, value) {
  const entry = PROP_MAP[property];
  const existing = el.getAttribute("style");

  let out = value;
  if (NUMERIC_VALUE_RE.test(value)) {
    let num = Number(value);
    if (property === "x") num = computeGeomDelta(authoredOffsetPx(existing, "left"), num);
    if (property === "y") num = computeGeomDelta(authoredOffsetPx(existing, "top"), num);
    out = `${num}${entry.unit}`;
  }
  el.setAttribute("style", mergeStyle(existing, entry.output, out));

  const consumption = GEOM_CONSUMPTION[property] || null;
  if (!consumption) return;
  const sep = consumption.indexOf(":");
  el.setAttribute(
    "style",
    mergeStyle(el.getAttribute("style"), consumption.slice(0, sep).trim(), consumption.slice(sep + 1).trim()),
  );
}

/** Only `#id` selectors are accepted for patch application. */
export function assertIdSelector(selector) {
  if (typeof selector !== "string" || !/^#[A-Za-z][\w-]*$/.test(selector)) {
    throw Object.assign(new Error(`unsupported selector: ${selector} (only #id allowed)`), {
      status: 400,
    });
  }
  return selector.slice(1);
}

/**
 * Apply `{selector, property, value}` patches to an HTML string via
 * linkedom. Returns the patched HTML. Missing elements are skipped.
 */
export function applyPatchesLinkedom(html, patches) {
  const { document } = parseHTML(html);
  let applied = 0;
  for (const patch of patches) {
    const id = assertIdSelector(patch.selector);
    const el = document.getElementById(id);
    if (!el) continue;
    const property = String(patch.property);
    const value = String(patch.value ?? "");
    if (property === "textContent") {
      el.textContent = value;
    } else if (property === "src") {
      el.setAttribute("src", value);
    } else if (property === "background-image") {
      el.setAttribute("style", mergeStyle(el.getAttribute("style"), "background-image", value.startsWith("url(") ? value : `url(${value})`));
    } else if (PROP_MAP[property]?.kind === "geom") {
      applyGeometryPatch(el, property, value);
    } else if (PROP_MAP[property]?.kind === "decl") {
      const cssProp = PROP_MAP[property].output;
      el.setAttribute("style", mergeStyle(el.getAttribute("style"), cssProp, addDeclUnit(cssProp, value)));
    } else {
      // Unknown property: pass through verbatim (legacy behaviour).
      el.setAttribute("style", mergeStyle(el.getAttribute("style"), property, value));
    }
    applied += 1;
  }
  return { html: document.toString(), applied };
}

/** Merge one `prop: value` declaration into an existing style attribute.
 * Canonical form (single spaces, no trailing `;`) guarantees re-applying the
 * same geometry patches converges byte-exactly (idempotent persists). */
function mergeStyle(existing, prop, value) {
  const decl = `${prop}: ${value}`;
  if (!existing) return decl;
  const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*[^;]*;?`, "i");
  const m = existing.match(re);
  if (m) {
    const sep = m[1];
    const atEnd = m.index + m[0].length >= existing.length;
    return existing.replace(re, () => `${sep ? `${sep} ` : ""}${decl}${atEnd ? "" : ";"}`);
  }
  return `${existing.replace(/;\s*$/, "")}; ${decl}`;
}

// ── V5-P0C: frame-exact window serialization (seek determinism) ─────────────
// The runtime evaluates visibility per element as
//   t >= parseFloat(data-start) && t < parseFloat(data-start) + parseFloat(data-duration)
// with t on the frame grid (f/fps). Decimal rounding of the attributes makes
// `start + duration` overshoot the next written start by rounding noise and
// TWO scenes render at boundary ticks (B2). The helpers below guarantee the
// float-exact invariant: for every integer frame f,
// exactly one clip window contains fl(f/fps).

/** Bit-decrement for positive finite doubles → previous representable value. */
const f64Scratch = new Float64Array(1);
const u64Scratch = new BigUint64Array(f64Scratch.buffer);
function nextDownDouble(v) {
  f64Scratch[0] = v;
  u64Scratch[0] -= 1n;
  return f64Scratch[0];
}

/**
 * Serialize the duration of the window [a, b) such that the runtime-computed
 * end `parse(a) + parse(d)` never exceeds the next boundary double `b`.
 * Candidate is the exact double difference; if summation still overshoots
 * (double-rounding), step down by 1 ULP — leaving at most a femtosecond-scale
 * gap that frame-grid seeks can never land in.
 */
export function exactWindowDuration(a, b) {
  let d = b - a;
  let guard = 0;
  while (a + d > b && guard < 8) {
    d = nextDownDouble(d);
    guard += 1;
  }
  return d;
}

/**
 * V5-P0C §2.1: quantize top-level clip windows to the frame grid with
 * contiguous boundaries (fronteira N = fim da N−1, sem overlap/gap).
 *
 * Only clips OWNED BY THE COMPOSITION ROOT are rewritten; nested composition
 * internals keep their own timeline. Clips without a usable data-duration
 * pass through untouched.
 *
 * @param {string} html Composition HTML.
 * @param {number} fps Frame grid (default 30).
 * @returns {{ html: string, adjusted: Array<{id: string|null, from: {start: string, duration: string}, to: {start: string, duration: string}}> }}
 */
export function normalizeClipWindows(html, fps = 30) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw Object.assign(new Error("fps must be a positive number"), { status: 400 });
  }
  const { document } = parseHTML(html);
  const rootEl = document.querySelector("[data-composition-id]");
  const clips = Array.from(document.querySelectorAll(".clip")).filter((el) => {
    const owner = el.closest("[data-composition-id]");
    return owner === null || owner === rootEl;
  });

  const adjusted = [];
  let cursorFrames = 0;
  for (const el of clips) {
    const rawDuration = parseFloat(el.getAttribute("data-duration"));
    if (!Number.isFinite(rawDuration) || rawDuration <= 0) continue;
    // sec*fps → round → /fps (master plan §5.2.1): the grid is integer frames.
    const frames = Math.max(1, Math.round(rawDuration * fps));
    const startSec = cursorFrames / fps;
    cursorFrames += frames;
    const nextSec = cursorFrames / fps;
    const durSec = exactWindowDuration(startSec, nextSec);
    const from = {
      start: el.getAttribute("data-start") ?? "",
      duration: el.getAttribute("data-duration") ?? "",
    };
    const to = { start: String(startSec), duration: String(durSec) };
    if (from.start !== to.start || from.duration !== to.duration) {
      el.setAttribute("data-start", to.start);
      el.setAttribute("data-duration", to.duration);
      adjusted.push({ id: el.id || el.getAttribute("data-hf-id") || null, from, to });
    }
  }

  return { html: document.toString(), adjusted };
}

/**
 * V4-04C §2.3: rewrite the composition timeline from editor scenes.
 *
 * @param {string} html Composition HTML.
 * @param {Array<{id: string, durationFrames: number}>} scenes Ordered scenes.
 * @param {number} fps Timeline fps (default 30).
 * @returns {{ html: string, applied: number, removed: string[] }}
 */
export function applyTimelineRestructure(html, scenes, fps = 30) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw Object.assign(new Error("scenes must be a non-empty array"), { status: 400 });
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw Object.assign(new Error("fps must be a positive number"), { status: 400 });
  }

  const { document } = parseHTML(html);
  const root = document.querySelector('[data-composition-id]');
  // V5-P0C: only clips owned by THE composition root are scene clips —
  // nested composition internals keep their own timeline.
  const allClips = Array.from(document.querySelectorAll(".clip")).filter((el) => {
    const owner = el.closest("[data-composition-id]");
    return owner === null || owner === root;
  });

  const keepIds = new Set(scenes.map((s) => String(s.id)));
  const removed = [];
  for (const clip of allClips) {
    const id = clip.id || clip.getAttribute("data-hf-id");
    if (id && !keepIds.has(id)) {
      removed.push(id);
      clip.remove();
    }
  }

  // V5-P0C §2.1: quantize to the frame grid (integer boundaries) and
  // serialize with float-exact contiguity — the runtime must never see
  // two windows covering the same frame tick (B2.1).
  const entries = [];
  for (const scene of scenes) {
    const el = document.getElementById(String(scene.id));
    if (!el) continue; // scene not present in the composition — skip
    const frames = Number(scene.durationFrames);
    if (!Number.isFinite(frames) || frames <= 0) {
      throw Object.assign(new Error(`scene ${scene.id} has invalid durationFrames`), { status: 400 });
    }
    entries.push({ el, frames: Math.round(frames) });
  }

  let cursorFrames = 0;
  let applied = 0;
  for (const { el, frames } of entries) {
    const startSec = cursorFrames / fps;
    cursorFrames += frames;
    const nextSec = cursorFrames / fps;
    el.setAttribute("data-start", String(startSec));
    el.setAttribute("data-duration", String(exactWindowDuration(startSec, nextSec)));
    applied += 1;
  }
  const totalSec = cursorFrames / fps;

  if (root && entries.length > 0) {
    root.setAttribute("data-duration", String(totalSec));
  }

  return { html: document.toString(), applied, removed };
}
