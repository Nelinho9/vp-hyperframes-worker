/**
 * patch-engine — V4-04C: linkedom-backed HTML patch + timeline restructure
 *
 * Shared semantics with src/video/v4/patchHtml.ts (kept in sync — the table
 * below mirrors PROP_TO_CSS / NUMERIC_PROPS):
 *   - `textContent` → textContent
 *   - `src`         → attribute
 *   - `background-image` → wrap `url(...)`
 *   - `x`→`left`, `y`→`top`, `font`→`font-family`, `size`→`font-size`,
 *     `weight`→`font-weight`
 *   - numeric values get `px` (NUMERIC_PROPS list)
 *
 * Patches target `#id` selectors ONLY (400 from the routes otherwise) —
 * arbitrary selectors would let an authenticated user rewrite the runtime
 * scripts of a composition.
 *
 * `applyTimelineRestructure` rewrites the composition deterministically from
 * an editor timeline: per-clip data-duration = durationFrames/fps, data-start
 * recomputed cumulatively, clips whose id vanished are removed, and the root
 * data-duration becomes the new total.
 */

import { parseHTML } from "linkedom";

const PROP_TO_CSS = {
  font: "font-family",
  size: "font-size",
  weight: "font-weight",
  color: "color",
  opacity: "opacity",
  width: "width",
  height: "height",
  x: "left",
  y: "top",
};

const NUMERIC_PROPS = new Set([
  "font-size", "width", "height", "left", "top",
  "margin", "padding", "border-width",
]);

function addUnit(cssProp, value) {
  if (NUMERIC_PROPS.has(cssProp) && /^\d+(\.\d+)?$/.test(value)) return `${value}px`;
  return value;
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
    } else {
      const cssProp = PROP_TO_CSS[property] || property;
      el.setAttribute("style", mergeStyle(el.getAttribute("style"), cssProp, addUnit(cssProp, value)));
    }
    applied += 1;
  }
  return { html: document.toString(), applied };
}

/** Merge one `prop: value` declaration into an existing style attribute. */
function mergeStyle(existing, prop, value) {
  const decl = `${prop}: ${value}`;
  if (!existing) return decl;
  const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*[^;]*;?`, "i");
  if (re.test(existing)) {
    return existing.replace(re, (_match, sep) => `${sep}${decl};`);
  }
  return `${existing.replace(/;\s*$/, "")}; ${decl}`;
}

function formatSeconds(sec) {
  // Trim floating noise: 6.6666666667 → 6.667
  const rounded = Math.round(sec * 1000) / 1000;
  return String(rounded);
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
  const allClips = Array.from(document.querySelectorAll(".clip")).filter(
    (el) => el.getAttribute("data-composition-id") === null,
  );

  const keepIds = new Set(scenes.map((s) => String(s.id)));
  const removed = [];
  for (const clip of allClips) {
    const id = clip.id || clip.getAttribute("data-hf-id");
    if (id && !keepIds.has(id)) {
      removed.push(id);
      clip.remove();
    }
  }

  let cursor = 0;
  let applied = 0;
  let total = 0;
  for (const scene of scenes) {
    const id = String(scene.id);
    const el = document.getElementById(id);
    if (!el) continue; // scene not present in the composition — skip
    const frames = Number(scene.durationFrames);
    if (!Number.isFinite(frames) || frames <= 0) {
      throw Object.assign(new Error(`scene ${id} has invalid durationFrames`), { status: 400 });
    }
    const durationSec = frames / fps;
    el.setAttribute("data-start", formatSeconds(cursor));
    el.setAttribute("data-duration", formatSeconds(durationSec));
    cursor += durationSec;
    total += durationSec;
    applied += 1;
  }

  if (root) {
    root.setAttribute("data-duration", formatSeconds(total > 0 ? total : cursor));
  }

  return { html: document.toString(), applied, removed };
}
