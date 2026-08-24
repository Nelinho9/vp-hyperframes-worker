/**
 * preview-helper — V4-3f.3 (A3): click-to-edit helper injected into previews
 *
 * `GET /preview/:id` serves the composition HTML with a small inline script
 * injected before `</body>`. The helper implements BOTH directions of the
 * PreviewCanvas ↔ iframe protocol (docs: V4_03_STUDIO_UX_REFINED.md §3.1/§3.2):
 *
 * iframe → parent (sent with targetOrigin '*' — the PARENT validates origin):
 *   { action: 'select',   elementId, bbox: {x,y,w,h} }  on click of [id]/[data-hf-id]
 *   { action: 'deselect' }                              on click outside any element
 *
 * parent → iframe (V4-3e hot-swap receiver):
 *   { action: 'patch',     patches: [{selector, property, value}] }
 *   { action: 'seek',      frame }        (V4-04A legacy — shimmed)
 *   { action: 'playpause', playing }      (V4-04A legacy — shimmed)
 *
 * V4-04A: transport (play/pause/seek) is owned by the runtime's own bridge
 * protocol — the frontend posts `hf-parent/hf-control` envelopes straight to
 * the iframe window. The legacy helper actions are mapped to that envelope
 * defensively (compat shim); the dead `window.HyperFrames|HF|__HYPERFRAMES__`
 * runtime lookup is removed (those globals never existed — the real runtime
 * exposes only `window.__hyperframes = {fitTextFontSize, getVariables}`).
 *
 * V4-04D §2.4: window errors / unhandled rejections are reported to the
 * parent as `{source:'hf-preview', type:'diagnostic', code:'page.error'}` so
 * broken compositions are diagnosable from the editor.
 *
 * Patch semantics mirror src/video/v4/patchHtml.ts via the shared V5-P0B
 * canonical table (`prop-map.js`, JSON-stringified into the inline script):
 *   textContent → innerText; src → attribute; background-image → url(...) wrap;
 *   decl props (font/size/weight/color/opacity) → mapped CSS property (+px).
 *   GEOMETRY (x/y/width/height/rotation) → AD-1: `--el-*` custom properties
 *   consumed by individual transforms / layout vars on the SAME element —
 *   NEVER left/top literals (B1.3). x/y are ABSOLUTE composition coordinates
 *   converted to a translate DELTA against the element rect captured at the
 *   first geometry edit of the session (WeakMap baseline); accumulated deltas
 *   converge with the worker's authored-left/top recomputation on persist.
 */

/** Marker id used to keep injection idempotent. */
export const HELPER_SCRIPT_ID = '__vp-preview-helper__';

/** Marker attribute for the serve-time runtime tag (idempotency). */
export const RUNTIME_SCRIPT_MARKER = 'data-vp-preview-runtime';

/**
 * V4_04A fix: inject the HyperFrames runtime into a preview response.
 *
 * `sanitizeCompositionForOffline` strips runtime <script src> tags from the
 * staged composition and never inlines the runtime ("intentionally never
 * inlined" — the HyperFrames CLI injects its own bundle at lint/check/RENDER
 * time). But `mode:'preview'` never runs the CLI, so served previews had NO
 * runtime: the hf-preview transport bridge never booted, `ready` never
 * reached PreviewCanvas and the editor permanently showed the
 * "runtime did not respond" banner.
 *
 * This injects a <script> pointing at the worker's vendored bundle
 * (`GET /preview/:id/__vp_runtime.js`) right after <head> so the runtime
 * boots as early as possible. The STORED index.html stays untouched — the
 * lint/render contract is unaffected. Idempotent via the marker attribute.
 *
 * @param {string} html Composition HTML about to be served.
 * @param {string} src  URL of the vendored runtime bundle.
 * @returns {string} HTML with the runtime tag injected.
 */
export function injectPreviewRuntime(html, src) {
  if (typeof html !== 'string' || html.length === 0 || !src) return html;
  if (html.includes(RUNTIME_SCRIPT_MARKER)) return html;

  const tag = `<script ${RUNTIME_SCRIPT_MARKER} src="${src}"></script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${tag}`);
  }
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose === -1) return tag + '\n' + html;
  return html.slice(0, bodyClose) + tag + '\n' + html.slice(bodyClose);
}

/**
 * V5-P0B: inspector prop → CSS/geometry mapping — JSON-stringified into the
 * inline script below. Mirror of `prop-map.js` (see that module for the
 * cross-repo parity contract).
 */
import { PROP_MAP, GEOM_CONSUMPTION } from "./prop-map.js";

/**
 * The inline helper script body (browser-only, ES5-compatible, no imports).
 * Self-contained: must never reference worker-side identifiers.
 */
export const PREVIEW_HELPER_SCRIPT = `(function () {
  if (window.__vpPreviewHelperLoaded) return;
  window.__vpPreviewHelperLoaded = true;

  // V5-P0B canonical table (prop-map.js) — geometry NEVER maps to left/top.
  var PROP_MAP = ${JSON.stringify(PROP_MAP)};
  var GEOM_CONSUMPTION = ${JSON.stringify(GEOM_CONSUMPTION)};
  var NUMERIC_VALUE_RE = /^-?\\d+(\\.\\d+)?$/;
  var DECL_NUMERIC_PROPS = { 'font-size': 1, margin: 1, padding: 1, 'border-width': 1 };

  function addUnit(cssProp, value) {
    if (DECL_NUMERIC_PROPS[cssProp] && NUMERIC_VALUE_RE.test(value)) return value + 'px';
    return value;
  }

  // ── V5-P0B (AD-1): geometry via --el-* vars + individual transforms ──
  // x/y arrive as ABSOLUTE composition coordinates; the translate DELTA is
  // computed against the element rect captured at the FIRST geometry edit of
  // the session (translate starts unset ⇒ rect == authored visual position).
  // Accumulated deltas always equal desired_latest − baseline_first, which
  // converges with the worker's authored-left/top recomputation on persist.
  var GEOM_BASELINES = (typeof WeakMap === 'function') ? new WeakMap() : null;

  function geomBaseline(el) {
    if (!GEOM_BASELINES) return { x: 0, y: 0 };
    var b = GEOM_BASELINES.get(el);
    if (!b) {
      var r = el.getBoundingClientRect();
      b = { x: r.left, y: r.top };
      GEOM_BASELINES.set(el, b);
    }
    return b;
  }

  function applyGeometryPatch(el, property, value) {
    var entry = PROP_MAP[property];
    if (!entry || entry.kind !== 'geom') return false;
    var out = value;
    if (NUMERIC_VALUE_RE.test(value)) {
      var num = parseFloat(value);
      if (property === 'x' || property === 'y') {
        var b = geomBaseline(el);
        num = property === 'x' ? num - b.x : num - b.y;
      }
      out = num + entry.unit;
    }
    el.style.setProperty(entry.output, out);
    var consumption = GEOM_CONSUMPTION[property] || null;
    if (consumption) {
      var sep = consumption.indexOf(':');
      el.style.setProperty(consumption.slice(0, sep).trim(), consumption.slice(sep + 1).trim());
    }
    return true;
  }

  // ── V4-04D §2.4: surface page errors as runtime diagnostics ──────────
  function reportDiagnostic(code, message) {
    try {
      parent.postMessage({ source: 'hf-preview', type: 'diagnostic', code: code, details: { message: message } }, '*');
    } catch (e) { /* never break the preview */ }
  }
  window.addEventListener('error', function (ev) {
    reportDiagnostic('page.error', ev && ev.message ? ev.message : 'unknown error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    reportDiagnostic('page.unhandledrejection', ev && ev.reason ? String(ev.reason) : 'unknown rejection');
  });

  // ── V4-04A: compat shim — legacy helper actions → hf-parent control ──
  // The vendored runtime listens on the IFRAME window for
  // {source:'hf-parent', type:'control', action:…} envelopes; re-dispatch
  // them into the same window so the runtime's own listener handles them.
  function shimControl(action, params) {
    try {
      window.postMessage(Object.assign({ source: 'hf-parent', type: 'control', action: action }, params), '*');
    } catch (e) { /* best effort */ }
  }

  // ── iframe → parent: click selection ─────────────────────────────────
  document.addEventListener('click', function (ev) {
    try {
      var target = ev.target;
      var el = target && target.closest ? target.closest('[id],[data-hf-id]') : null;
      if (!el) {
        parent.postMessage({ action: 'deselect' }, '*');
        return;
      }
      var id = el.getAttribute('data-hf-id') || el.id;
      var r = el.getBoundingClientRect();
      parent.postMessage({
        action: 'select',
        elementId: id,
        bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      }, '*');
    } catch (e) { /* never break the preview */ }
  }, true);

  // ── parent → iframe: hot-swap receiver (patch / seek / playpause) ────
  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || typeof data !== 'object' || typeof data.action !== 'string') return;

    if (data.action === 'patch' && Object.prototype.toString.call(data.patches) === '[object Array]') {
      for (var i = 0; i < data.patches.length; i++) {
        var p = data.patches[i];
        if (!p || typeof p.selector !== 'string' || typeof p.property !== 'string') continue;
        var el = null;
        try { el = document.querySelector(p.selector); } catch (e) { continue; }
        if (!el) continue;
        var value = String(p.value == null ? '' : p.value);
        if (p.property === 'textContent') {
          el.textContent = value;
        } else if (p.property === 'src') {
          el.setAttribute('src', value);
        } else if (p.property === 'background-image') {
          el.style.backgroundImage = value.indexOf('url(') === 0 ? value : ('url(' + value + ')');
        } else if (applyGeometryPatch(el, p.property, value)) {
          // V5-P0B: geometry via --el-* vars + individual transforms (AD-1).
        } else {
          var entry = PROP_MAP[p.property];
          var cssProp = entry && entry.kind === 'decl' ? entry.output : p.property;
          el.style.setProperty(cssProp, addUnit(cssProp, value));
        }
      }
    } else if (data.action === 'seek') {
      // V4-04A: legacy channel — forward through the runtime bridge envelope.
      shimControl('seek', { frame: data.frame, fps: data.fps || 30 });
    } else if (data.action === 'playpause') {
      // V4-04A: legacy channel — map to the runtime play/pause actions.
      shimControl(data.playing ? 'play' : 'pause', {});
    }
  });
})();`;

/**
 * Inject the click-to-edit helper script into a composition HTML string.
 * Idempotent (skips when the marker script is already present). Inserts
 * before `</body>` when present, otherwise appends at the end.
 *
 * @param {string} html Composition HTML served for preview.
 * @returns {string} HTML with the helper script injected.
 */
export function injectPreviewHelper(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (html.includes(`id="${HELPER_SCRIPT_ID}"`)) return html;

  const tag = `<script id="${HELPER_SCRIPT_ID}">${PREVIEW_HELPER_SCRIPT}</script>`;
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose === -1) {
    return html + '\n' + tag;
  }
  return html.slice(0, bodyClose) + tag + '\n' + html.slice(bodyClose);
}
