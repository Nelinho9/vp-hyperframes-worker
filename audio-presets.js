/**
 * audio-presets — V5-P5B/S23 (§10.3): materialização de volume/fades de
 * áudio em TWEENS GSAP REAIS na timeline pausada existente.
 *
 * Espelho OBRIGATÓRIO do módulo app `src/video/v4/audioMaterialize.ts`
 * (repos separados não partilham import; paridade SEMÂNTICA garantida por
 * testes nos dois lados que exigem os mesmos marcadores/guards).
 *
 * O bloco `<script id="__vp-audio-materialized__">` deriva as specs do DOM
 * a cada execução (imune a /restructure e re-patches), usa tweens ABSOLUTOS
 * `fromTo(el, {volume}, {volume})` posicionados na janela do próprio clip e
 * killTweensOf próprio — seek-safe por construção (mesma estratégia da S09).
 */

export const AUDIO_BLOCK_ID = "__vp-audio-materialized__";
export const AUDIO_APPLY_FN_NAME = "__vpApplyAudioProps";

/** Fonte ES5 (sem arrow/let/const) injetada no documento. */
export const AUDIO_APPLY_SOURCE = [
  "function __vpApplyAudioProps(){",
  "  try {",
  '    var tl = (window.__timelines || {})["main"];',
  '    if (!tl || typeof tl.fromTo !== "function" || !window.gsap) return;',
  '    var nodes = document.querySelectorAll("audio[data-fade-in],audio[data-fade-out]");',
  "    Array.prototype.forEach.call(nodes, function(el){",
  '      var start = parseFloat(el.getAttribute("data-start")); if (!isFinite(start)) start = 0;',
  '      var dur = parseFloat(el.getAttribute("data-duration"));',
  '      var vol = parseFloat(el.getAttribute("data-volume")); if (!isFinite(vol)) vol = 1;',
  "      if (!isFinite(dur) || dur <= 0) return;",
  '      var fIn = (parseFloat(el.getAttribute("data-fade-in")) || 0) / 1000;',
  '      var fOut = (parseFloat(el.getAttribute("data-fade-out")) || 0) / 1000;',
  "      var maxFade = Math.max(0, dur - 0.5);",
  "      if (fIn + fOut > maxFade) { var k = maxFade / (fIn + fOut); fIn *= k; fOut *= k; }",
  '      try { window.gsap.killTweensOf(el, "volume"); } catch (e) {}',
  "      el.volume = Math.max(0, Math.min(1, vol));",
  '      if (fIn > 0) tl.fromTo(el, { volume: 0 }, { volume: vol, duration: fIn, ease: "none" }, start);',
  '      if (fOut > 0) tl.fromTo(el, { volume: vol }, { volume: 0, duration: fOut, ease: "none" }, start + dur - fOut);',
  "    });",
  "  } catch (err) { /* nunca quebrar a composição por áudio */ }",
  "}",
  'if (typeof window !== "undefined") {',
  '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __vpApplyAudioProps);',
  "  else __vpApplyAudioProps();",
  "}",
].join("\n");

/** Bloco <script> completo (id único, bootstrap protegido). */
export function buildAudioBlock() {
  return `<script id="${AUDIO_BLOCK_ID}">try{${AUDIO_APPLY_SOURCE}}catch(e){}</script>`;
}

/**
 * Upsert idempotente do bloco antes de </body> (substitui bloco anterior;
 * sem </body>, acrescenta no fim — mesmo contrato do anim block).
 */
export function upsertAudioBlock(html) {
  if (typeof html !== "string" || !html) return html;
  const openTag = `<script id="${AUDIO_BLOCK_ID}"`;
  const openIdx = html.indexOf(openTag);
  if (openIdx !== -1) {
    const closeTag = "</script>";
    const closeIdx = html.indexOf(closeTag, openIdx);
    if (closeIdx !== -1) {
      return html.slice(0, openIdx) + buildAudioBlock() + html.slice(closeIdx + closeTag.length);
    }
  }
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose === -1) return html + buildAudioBlock();
  return html.slice(0, bodyClose) + buildAudioBlock() + html.slice(bodyClose);
}

/** Props de áudio (V5-P5C) que exigem regeneração do bloco num lote. */
const AUDIO_PROPS = new Set(["volume", "muted", "fadeIn", "fadeOut"]);

export function touchesAudioProps(patches) {
  if (!Array.isArray(patches)) return false;
  return patches.some(
    (p) => p && typeof p.property === "string" && AUDIO_PROPS.has(p.property)
  );
}
