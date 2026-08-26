/**
 * preview-helper — V4-3f.3 (A3): click-to-edit helper injected into previews
 *
 * `GET /preview/:id` serves the composition HTML with a small inline script
 * injected before `</body>`. The helper implements BOTH directions of the
 * PreviewCanvas ↔ iframe protocol (docs: V4_03_STUDIO_UX_REFINED.md §3.1/§3.2):
 *
 * iframe → parent (sent with targetOrigin '*' — the PARENT validates origin):
 *   { action: 'select',   elementId, bbox: {x,y,w,h}, src? }  on click of
 *     [id]/[data-hf-id]; V5-P1C: src transporta o atributo vivo de elementos
 *     media (hidrata a thumb do inspector — NUNCA entra nas props editáveis)
 *   { action: 'deselect' }                              on click outside any element
 *   { action: 'edit-start', elementId, bbox }           V5-P1B: dblclick on a
 *     TEXT element entered inline-edit mode (contentEditable on the element)
 *   { action: 'text-input', elementId, text, bbox }     V5-P1B: debounced 300ms
 *     input while editing (textContent of the editable)
 *   { action: 'edit-end',  elementId, text, bbox }      V5-P1B: commit on
 *     blur/Enter/Esc (Esc restores the original text first)
 *   { source:'hf-preview', action:'element-at-point', elementId|null,
 *     elementType?, bbox?, src? }                       V5-P1C: resposta ao
 *     hit-test do drop mediado pelo pai (coords NATIVAS da composição)
 *   { source:'hf-preview', action:'element-scene', elementId,
 *     startSeconds, durationSeconds|null }              V5-P1D: resposta ao
 *     pedido de replay — janela timed do elemento (host [data-start] mais
 *     próximo; null = full-length)
 *   { source:'hf-preview', action:'element-duplicated', fromId, newId, bbox }
 *     V5-P1E: confirmação da operação `duplicate` — id determinístico
 *     `${fromId}-copy-N` (menor N livre) e bbox medida pós-inserção
 *   { source:'hf-preview', action:'element-bbox', elementId, bbox|null, src? }
 *     V5-P3C: resposta ao pedido de focus programático — bbox MEDIDA na
 *     página viva (null = elemento inexistente; o pai degrada sem overlay)
 *
 * parent → iframe (V4-3e hot-swap receiver):
 *   { action: 'patch',     patches: [{selector, property, value}] }  —
 *     V5-P1E: a propriedade RESERVADA `element` com valores 'remove' /
 *     'duplicate' executa OPERAÇÕES DE NÓ na página viva (sem reload);
 *     cenas (.clip dono-da-raiz) são recusadas — estruturais, via timeline.
 *   { action: 'element-at-point', x, y }  (V5-P1C — hit-test para o drop;
 *     coords NATIVAS: o pai converte clientX/Y via transform inverso do stage)
 *   { action: 'element-scene', elementId } (V5-P1D — janela para o replay de
 *     presets de animação; o pai faz seek+play curto com a resposta)
 *   { action: 'element-bbox', elementId }  (V5-P3C — focus programático:
 *     flash+select do tab Assets; o pai seleciona com a bbox real)
 *
 * V4-04A: transport (play/pause/seek) is owned by the runtime's own bridge
 * protocol — the frontend posts `hf-parent/hf-control` envelopes straight to
 * the iframe window (V5-P8C: helper shim legacy removido — o pai não emite
 * mais `{action:'seek'|'playpause'}`). The dead `window.HyperFrames|
 * HF|__HYPERFRAMES__` runtime lookup is removed (those globals never existed —
 * the real runtime exposes only `window.__hyperframes = {fitTextFontSize,
 * getVariables}`).
 *
 * V4-04D §2.4: window errors / unhandled rejections are reported to the
 * parent as `{source:'hf-preview', type:'diagnostic', code:'page.error'}` so
 * broken compositions are diagnosable from the editor.
 *
 * Patch semantics mirror src/video/v4/patchHtml.ts via the shared V5-P0B/P1A
 * canonical table (`prop-map.js`, JSON-stringified into the inline script):
 *   textContent / `text` alias → innerText; src → attribute;
 *   background-image → url(...) wrap; decl props (font/size/color/align/
 *   radius/…) → mapped CSS property with the table unit (V5-P1A);
 *   animation props → `data-anim-*` ATTRIBUTES, never style (V5-P1A) and —
 *   V5-P1D §2.4 — batches that touch them re-apply the animation presets
 *   LOCALLY (shared ES5 source from `anim-presets.js`): tweens GSAP are
 *   rebuilt on the LIVE timeline without reloading the iframe. UI-only flags
 *   filtered out (aceitação P1 #4).
 *   GEOMETRY (x/y/width/height/rotation) → AD-1: `--el-*` custom properties
 *   consumed by individual transforms / layout vars on the SAME element —
 *   NEVER left/top literals (B1.3). x/y are ABSOLUTE composition coordinates
 *   converted to a translate DELTA against the element rect captured at the
 *   first geometry edit of the session (WeakMap baseline); accumulated deltas
 *   converge with the worker's authored-left/top recomputation on persist.
 *   NODE OPS (V5-P1E §6.5): reserved property `element` with values
 *   'remove' | 'duplicate' mutates the LIVE page (no reload) with the same
 *   semantics as the persistence engines — deterministic `-copy-N` id,
 *   clone inserted as the NEXT SIBLING, root-owned scene clips refused.
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
 * V5-P0B: inspector prop → CSS/geometry/attribute mapping — JSON-stringified
 * into the inline script below. Mirror of `prop-map.js` (see that module for
 * the cross-repo parity contract). V5-P1A adds UI_ONLY_PROPS (filtered).
 */
import { PROP_MAP, GEOM_CONSUMPTION, UI_ONLY_PROPS } from "./prop-map.js";
import { AUDIO_APPLY_SOURCE } from "./audio-presets.js";
import { ANIM_APPLY_SOURCE } from "./anim-presets.js";
import { KEYFRAME_APPLY_SOURCE } from "./keyframes-presets.js";

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
  // V5-P1A: UI-only flags are filtered (never become invalid CSS).
  var UI_ONLY_PROPS = ${JSON.stringify([...UI_ONLY_PROPS])};
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
      var msg = {
        action: 'select',
        elementId: id,
        bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      };
      // V5-P1C: atributo src VIVO (media elements) — hidrata a thumb do
      // inspector; o pai guarda-o FORA das props editáveis (nunca persistido).
      var liveSrc = typeof el.getAttribute === 'function' ? el.getAttribute('src') : null;
      if (liveSrc) msg.src = liveSrc;
      // V5-P8B §2.1: keyframes vivas — inspector/preview mostram o estado real.
      var kfRaw = typeof el.getAttribute === 'function' ? el.getAttribute('data-kf') : null;
      if (kfRaw) msg.keyframes = kfRaw;
      // V5-P5C §10.3: props de áudio VIVAS — inspector mostra o estado real.
      if (el.tagName === 'AUDIO') {
        msg.audio = parseAudioAttrs(el);
      }
      parent.postMessage(msg, '*');
    } catch (e) { /* never break the preview */ }
  }, true);

  // ── V5-P1B: inline text editing (double-click → contentEditable) ─────
  // The helper owns the edit session; the parent owns transport/persistence.
  // Text flows OUT as debounced 'text-input' envelopes and comes back as
  // ordinary hot-swap 'text' patches (echo — suppressed below while the
  // value equals the live editable content, so the caret is never clobbered).
  var EDIT_DEBOUNCE_MS = 300;
  var activeEditor = null;      // element being edited (or null)
  var originalText = '';        // textContent captured at edit-start (Esc restore)
  var inputTimer = null;

  function inferElementTypeFromId(id) {
    // V5-P3B: forma estavel scene-N-type-K (com cauda -copy-M da duplicacao)
    // tem prioridade — o token do tipo e o 3.o segmento; prefixos legados
    // mantem-se. NOTA: corpo embutido em PREVIEW_HELPER_SCRIPT (template
    // literal) — nunca usar backticks nem interpolacoes neste bloco
    // (backslashes de regex sao duplos, como em NUMERIC_VALUE_RE).
    var s = String(id || '');
    var m = s.match(/^scene-\\d+-([a-z]+)-\\d+(?:-copy-\\d+)*$/);
    var tok = m ? m[1] : String(s.split('-')[0] || '').toLowerCase();
    if (tok === 'img' || tok === 'image') return 'image';
    if (tok === 'audio' || tok === 'voice' || tok === 'music' || tok === 'sfx' || tok === 'bgm') return 'audio';
    if (tok === 'video' || tok === 'footage') return 'video';
    return 'text';
  }

  function sendToParent(msg) {
    try { parent.postMessage(msg, '*'); } catch (e) { /* never break the preview */ }
  }

  function elementEnvelope(el, action) {
    var id = el.getAttribute('data-hf-id') || el.id;
    var r = el.getBoundingClientRect();
    return {
      action: action,
      elementId: id,
      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    };
  }

  function placeCaretAtEnd(el) {
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      if (sel && document.createRange) {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      el.focus();
    } catch (e) {
      try { el.focus(); } catch (e2) { /* non-focusable env (tests) */ }
    }
  }

  function detachEditListeners(el) {
    el.removeEventListener('input', onEditInput);
    el.removeEventListener('keydown', onEditKeydown);
    el.removeEventListener('blur', onEditBlur);
  }

  function finishEdit() {
    var el = activeEditor;
    if (!el) return;
    if (inputTimer !== null) { clearTimeout(inputTimer); inputTimer = null; }
    detachEditListeners(el);
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    activeEditor = null;
    var msg = elementEnvelope(el, 'edit-end');
    msg.text = el.textContent == null ? '' : el.textContent;
    sendToParent(msg);
  }

  function enterEditMode(el) {
    if (activeEditor === el) return;
    if (activeEditor) finishEdit(); // defensive: blur may not fire in every env
    activeEditor = el;
    originalText = el.textContent == null ? '' : el.textContent;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.addEventListener('input', onEditInput);
    el.addEventListener('keydown', onEditKeydown);
    el.addEventListener('blur', onEditBlur);
    sendToParent(elementEnvelope(el, 'edit-start'));
    placeCaretAtEnd(el);
  }

  function onEditInput() {
    if (!activeEditor) return;
    var el = activeEditor;
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      inputTimer = null;
      if (activeEditor !== el) return;
      var msg = elementEnvelope(el, 'text-input');
      msg.text = el.textContent == null ? '' : el.textContent;
      sendToParent(msg);
    }, EDIT_DEBOUNCE_MS);
  }

  function onEditKeydown(ev) {
    if (!activeEditor) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      activeEditor.textContent = originalText; // restore before commit
      finishEdit();
    } else if (ev.key === 'Enter') {
      // Enter is commit-only: contenteditable would insert <div>/<br> which
      // textContent flattens — multi-line stays explicitly out of scope.
      ev.preventDefault();
      finishEdit();
    }
  }

  function onEditBlur() {
    if (activeEditor) finishEdit();
  }

  document.addEventListener('dblclick', function (ev) {
    try {
      var target = ev.target;
      var el = target && target.closest ? target.closest('[id],[data-hf-id]') : null;
      if (!el) return;
      var id = el.getAttribute('data-hf-id') || el.id;
      if (inferElementTypeFromId(id) !== 'text') return;
      enterEditMode(el);
    } catch (e) { /* never break the preview */ }
  }, true);

  // ── V5-P1D §2.4: materialização local de presets de animação ─────────
  // Fonte partilhada com o bloco persistido (anim-presets.js). Um hot-swap
  // que toque data-anim-* reconstrói os tweens GSAP na timeline JÁ BINDADA
  // (children adicionados depois do bind continuam a ser conduzidos pelo
  // runtime) — sem reload do iframe.
  ${ANIM_APPLY_SOURCE}
  // ── V5-P8B §2.2: keyframes leves — mesma via S09/S23 ─────────────────
  ${KEYFRAME_APPLY_SOURCE}
  // ── V5-P5C/P5B §10.3: materialização local de volume/fades de áudio ──
  // Fonte partilhada com o bloco persistido (audio-presets.js) — mesma
  // estratégia da S09: hot-swap re-corre o applier na timeline já bindada,
  // sem reload do iframe.
  ${AUDIO_APPLY_SOURCE}
  function patchTouchesAnim(patches) {
    for (var i = 0; i < patches.length; i++) {
      var p = patches[i];
      if (p && /^(animIn|animOut|animDurMs|animDelayMs)$/.test(String(p.property))) return true;
    }
    return false;
  }

  // V5-P5C §10.3: lote tocou props de áudio (volume/muted/fadeIn/fadeOut)?
  function patchTouchesAudio(patches) {
    for (var i = 0; i < patches.length; i++) {
      var pr = patches[i] && patches[i].property;
      if (pr === 'volume' || pr === 'muted' || pr === 'fadeIn' || pr === 'fadeOut') return true;
    }
    return false;
  }

  // V5-P8B §2.2: lote tocou keyframes?
  function patchTouchesKeyframes(patches) {
    for (var i = 0; i < patches.length; i++) {
      var pr2 = patches[i] && patches[i].property;
      if (pr2 === 'keyframes') return true;
    }
    return false;
  }

  // V5-P5C: estado vivo IMEDIATO (volume/mute audíveis sem esperar seek;
  // os fades ficam a cargo do applier acima).
  function applyLiveAudioState() {
    try {
      var nodes = document.querySelectorAll('audio[data-volume],audio[data-muted]');
      Array.prototype.forEach.call(nodes, function (el) {
        var v = parseFloat(el.getAttribute('data-volume'));
        if (isFinite(v)) el.volume = Math.max(0, Math.min(1, v));
        el.muted = el.getAttribute('data-muted') === 'true';
      });
    } catch (e) { /* never break the preview */ }
  }

  // V5-P5C: props de áudio VIVAS para o envelope select (o inspector mostra
  // o estado real das tracks injetadas, não defaults).
  function parseAudioAttrs(el) {
    var out = {};
    var v = parseFloat(el.getAttribute('data-volume'));
    if (isFinite(v)) out.volume = v;
    out.muted = el.getAttribute('data-muted') === 'true';
    var fi = parseFloat(el.getAttribute('data-fade-in'));
    if (isFinite(fi)) out.fadeIn = fi;
    var fo = parseFloat(el.getAttribute('data-fade-out'));
    if (isFinite(fo)) out.fadeOut = fo;
    return out;
  }

  // ── V5-P1E §6.5: operações de nó no recetor patch ─────────────────────
  // Propriedade RESERVADA 'element' ('remove' | 'duplicate') — mesma
  // semântica dos motores de persistência (patchHtml.ts / patch-engine.js):
  // id determinístico base + '-copy-N' com N = menor inteiro livre, clone
  // inserido como irmão seguinte (mesma janela timed), autostamp limpo e
  // CENAS (.clip dono-da-raiz) recusadas — estruturais, via /restructure.
  function nextCopyId(doc, baseId) {
    for (var n = 1; ; n++) {
      var candidate = baseId + '-copy-' + n;
      if (!doc.getElementById(candidate)) return candidate;
    }
  }

  function isRootOwnedSceneClip(el, doc) {
    var isClip = false;
    try { isClip = Boolean(el.classList && el.classList.contains('clip')); } catch (eC) { return false; }
    if (!isClip) return false;
    var rootEl = doc.querySelector('[data-composition-id]');
    if (!rootEl) return false;
    var ownerEl = el.closest ? el.closest('[data-composition-id]') : null;
    return ownerEl === null || ownerEl === rootEl;
  }

  // ── parent → iframe: hot-swap receiver (patch / seek / playpause) ────
  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || typeof data !== 'object' || typeof data.action !== 'string') return;

    if (data.action === 'patch' && Object.prototype.toString.call(data.patches) === '[object Array]') {
      var nodeOpTouched = false;
      for (var i = 0; i < data.patches.length; i++) {
        var p = data.patches[i];
        if (!p || typeof p.selector !== 'string' || typeof p.property !== 'string') continue;
        var el = null;
        try { el = document.querySelector(p.selector); } catch (e) { continue; }
        if (!el) continue;
        var value = String(p.value == null ? '' : p.value);
        if (p.property === 'textContent' || p.property === 'text') {
          // V5-P1A: 'text' é alias aceite de textContent (modelo §6.1).
          // V5-P1B: eco da própria edição inline — quando o valor é IGUAL ao
          // conteúdo vivo do editor ativo não reescreve o nó (reescrever
          // substituiria os child nodes e colapsaria o caret). Valor
          // diferente (ex.: undo) aplica-se mesmo em edição.
          if (el === activeEditor && (el.textContent == null ? '' : el.textContent) === value) {
            break;
          }
          el.textContent = value;
        } else if (p.property === 'element') {
          // V5-P1E §6.5: operações de nó na página viva (hot-swap, sem
          // reload). Cenas recusadas — a timeline é a dona da estrutura.
          if (isRootOwnedSceneClip(el, document)) continue;
          if (value === 'remove') {
            if (el.parentNode) el.parentNode.removeChild(el);
            nodeOpTouched = true;
          } else if (value === 'duplicate') {
            var dupBase = el.id;
            if (dupBase) {
              var newId = nextCopyId(document, dupBase);
              var clone = el.cloneNode(true);
              clone.setAttribute('id', newId);
              try { clone.removeAttribute('data-hf-autostamped'); } catch (eA) {}
              if (el.parentNode) el.parentNode.insertBefore(clone, el.nextSibling);
              var r2 = typeof clone.getBoundingClientRect === 'function'
                ? clone.getBoundingClientRect()
                : { left: 0, top: 0, width: 0, height: 0 };
              sendToParent({
                source: 'hf-preview',
                action: 'element-duplicated',
                fromId: dupBase,
                newId: newId,
                bbox: { x: Math.round(r2.left), y: Math.round(r2.top), w: Math.round(r2.width), h: Math.round(r2.height) }
              });
              nodeOpTouched = true;
            }
          }
          // Valor desconhecido → sem efeito.
        } else if (p.property === 'src') {
          el.setAttribute('src', value);
        } else if (p.property === 'background-image') {
          el.style.backgroundImage = value.indexOf('url(') === 0 ? value : ('url(' + value + ')');
        } else if (UI_ONLY_PROPS.indexOf(p.property) !== -1) {
          // V5-P1A (aceitação P1 #4): flag sem efeito render — filtrada.
        } else if (applyGeometryPatch(el, p.property, value)) {
          // V5-P0B: geometry via --el-* vars + individual transforms (AD-1).
        } else {
          var entry = PROP_MAP[p.property];
          if (entry && entry.kind === 'attr') {
            // V5-P1A §2.2: animação via atributos data-anim-* (nunca style).
            // V5-P8B §2.1: keyframes '' apaga o atributo (zero keys → bloco some).
            if (value === '' && entry.output === 'data-kf') el.removeAttribute(entry.output);
            else el.setAttribute(entry.output, value);
          } else if (entry && entry.kind === 'decl') {
            var out = (entry.unit && NUMERIC_VALUE_RE.test(value)) ? value + entry.unit : value;
            el.style.setProperty(entry.output, out);
          } else {
            // Desconhecida: verbatim (comportamento legado).
            var cssProp = p.property;
            el.style.setProperty(cssProp, addUnit(cssProp, value));
          }
        }
      }
      // V5-P1D §2.4: lote tocou animação → re-materializar localmente.
      // V5-P1E: ops de nó TAMBÉM re-materializam — specs derivadas do DOM
      // pós-op (clone animado ganha tweens; tweens de nós removidos morrem).
      if (nodeOpTouched || patchTouchesAnim(data.patches)) {
        try { __vpApplyAnimations(); } catch (eAnim) { /* nunca quebrar o preview */ }
      }
      // V5-P8B §2.2: lote tocou keyframes (ou node-op) → re-materializar.
      if (nodeOpTouched || patchTouchesKeyframes(data.patches)) {
        try { __vpApplyKeyframes(); } catch (eKf) { /* nunca quebrar o preview */ }
      }
      // V5-P5C §10.3: lote tocou áudio → estado vivo imediato + fades.
      var audioTouched = patchTouchesAudio(data.patches);
      if (audioTouched) {
        try { applyLiveAudioState(); } catch (eAudio1) { /* nunca quebrar o preview */ }
        try { __vpApplyAudioProps(); } catch (eAudio2) { /* nunca quebrar o preview */ }
      }
    } else if (data.action === 'element-at-point' && typeof data.x === 'number' && typeof data.y === 'number') {
      // V5-P1C §2.3: hit-test para o drop de imagem mediado pelo pai.
      // Coordenadas NATIVAS da composição; responde com o elemento sob o
      // ponto (ou elementId:null). Ambientes sem layout (sem
      // elementFromPoint) respondem null — o pai simplesmente não destaca.
      try {
        var hp = typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(data.x, data.y)
          : null;
        var hitEl = hp && hp.closest ? hp.closest('[id],[data-hf-id]') : null;
        if (!hitEl) {
          sendToParent({ source: 'hf-preview', action: 'element-at-point', elementId: null });
        } else {
          var hitId = hitEl.getAttribute('data-hf-id') || hitEl.id;
          var hitR = hitEl.getBoundingClientRect();
          var hitMsg = {
            source: 'hf-preview',
            action: 'element-at-point',
            elementId: hitId,
            elementType: inferElementTypeFromId(hitId),
            bbox: { x: Math.round(hitR.left), y: Math.round(hitR.top), w: Math.round(hitR.width), h: Math.round(hitR.height) }
          };
          var hitSrc = typeof hitEl.getAttribute === 'function' ? hitEl.getAttribute('src') : null;
          if (hitSrc) hitMsg.src = hitSrc;
          sendToParent(hitMsg);
        }
      } catch (e) { /* never break the preview */ }
    } else if (data.action === 'element-scene' && typeof data.elementId === 'string') {
      // V5-P1D §2.5: janela timed do elemento para o replay de presets.
      // Host = [data-start] mais próximo (o próprio elemento incluído —
      // autostamp do runtime conta). Sem host: start 0, duração nula
      // (o pai ancora o out ao fim da composição).
      try {
        var sceneEl = document.getElementById(data.elementId);
        if (!sceneEl) {
          sendToParent({ source: 'hf-preview', action: 'element-scene', elementId: data.elementId, startSeconds: null, durationSeconds: null });
          return;
        }
        var host2 = sceneEl.closest ? sceneEl.closest('[data-start]') : null;
        var s0 = 0, d0 = null;
        if (host2) {
          var hStart = parseFloat(host2.getAttribute('data-start'));
          if (isFinite(hStart) && hStart >= 0) {
            s0 = hStart;
            var hDur = parseFloat(host2.getAttribute('data-duration'));
            if (isFinite(hDur) && hDur > 0) d0 = hDur;
          }
        }
        sendToParent({ source: 'hf-preview', action: 'element-scene', elementId: data.elementId, startSeconds: s0, durationSeconds: d0 });
      } catch (eS) { /* never break the preview */ }
    } else if (data.action === 'element-bbox' && typeof data.elementId === 'string') {
      // V5-P3C §2.5: bbox MEDIDA na página viva para o focus programático
      // (flash+select a partir do tab Assets). Responde SEMPRE — bbox null
      // quando o elemento não existe (o pai degrada sem overlay mentiroso).
      try {
        var fbEl = document.getElementById(data.elementId);
        if (!fbEl) {
          try { fbEl = document.querySelector('[data-hf-id="' + data.elementId + '"]'); } catch (eQ) { fbEl = null; }
        }
        if (!fbEl) {
          sendToParent({ source: 'hf-preview', action: 'element-bbox', elementId: data.elementId, bbox: null });
        } else {
          var fbMsg = elementEnvelope(fbEl, 'element-bbox');
          fbMsg.source = 'hf-preview';
          var fbSrc = typeof fbEl.getAttribute === 'function' ? fbEl.getAttribute('src') : null;
          if (fbSrc) fbMsg.src = fbSrc;
          sendToParent(fbMsg);
        }
      } catch (eB) { /* never break the preview */ }
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
