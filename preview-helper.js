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
 *   { action: 'seek',      frame }
 *   { action: 'playpause', playing }
 *
 * Patch semantics mirror src/video/v4/patchHtml.ts (kept in sync manually):
 *   textContent → innerText; src → attribute; background-image → url(...) wrap;
 *   anything else → CSS property (inspector names mapped, px units added).
 */

/** Marker id used to keep injection idempotent. */
export const HELPER_SCRIPT_ID = '__vp-preview-helper__';

/**
 * Inspector prop → CSS property mapping (same table as patchHtml.PROP_TO_CSS).
 */
const PROP_TO_CSS = {
  font: 'font-family',
  size: 'font-size',
  weight: 'font-weight',
  color: 'color',
  opacity: 'opacity',
  width: 'width',
  height: 'height',
  x: 'left',
  y: 'top',
};

/**
 * The inline helper script body (browser-only, ES5-compatible, no imports).
 * Self-contained: must never reference worker-side identifiers.
 */
export const PREVIEW_HELPER_SCRIPT = `(function () {
  if (window.__vpPreviewHelperLoaded) return;
  window.__vpPreviewHelperLoaded = true;

  var PROP_TO_CSS = ${JSON.stringify(PROP_TO_CSS)};
  var NUMERIC_PROPS = { 'font-size': 1, width: 1, height: 1, left: 1, top: 1, margin: 1, padding: 1, 'border-width': 1 };

  function addUnit(cssProp, value) {
    if (NUMERIC_PROPS[cssProp] && /^\\d+(\\.\\d+)?$/.test(value)) return value + 'px';
    return value;
  }

  function hfRuntime() {
    return window.HyperFrames || window.HF || window.__HYPERFRAMES__ || null;
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
        } else {
          var cssProp = PROP_TO_CSS[p.property] || p.property;
          el.style.setProperty(cssProp, addUnit(cssProp, value));
        }
      }
    } else if (data.action === 'seek') {
      try {
        var rt = hfRuntime();
        if (rt && typeof rt.seek === 'function') rt.seek(data.frame);
        else if (rt && typeof rt.seekToFrame === 'function') rt.seekToFrame(data.frame);
        document.dispatchEvent(new CustomEvent('vp-seek', { detail: { frame: data.frame } }));
      } catch (e) { /* best effort */ }
    } else if (data.action === 'playpause') {
      try {
        var rt2 = hfRuntime();
        if (rt2) {
          if (data.playing && typeof rt2.play === 'function') rt2.play();
          else if (!data.playing && typeof rt2.pause === 'function') rt2.pause();
        }
        document.dispatchEvent(new CustomEvent('vp-playpause', { detail: { playing: !!data.playing } }));
      } catch (e) { /* best effort */ }
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
