/**
 * audioMaterialize.ts — V5-P5B §2.3: bloco estático que materializa
 * volume/fades de áudio em TWEENS GSAP REAIS na timeline pausada existente
 * (mesma estratégia do bloco de animações da S09 — preview↔render coerentes
 * por construção: o CLI renderiza este MESMO documento).
 *
 * Canal declarativo: `audio[data-fade-in]/[data-fade-out]` + `data-volume`.
 * A fonte aplicadora é ES5 partilhada (paridade com o espelho do helper no
 * worker, como anim-presets.js↔animPresets.ts) e DERIVA as specs do DOM a
 * cada execução — imune a /restructure e a re-patches.
 */

export const AUDIO_BLOCK_ID = '__vp-audio-materialized__';
export const AUDIO_APPLY_FN_NAME = '__vpApplyAudioProps';

/** Fonte ES5 (sem arrow/let/const) injetada no documento. */
export const AUDIO_APPLY_SOURCE = `
function __vpApplyAudioProps(){
  try {
    var tl = (window.__timelines || {})["main"];
    if (!tl || typeof tl.fromTo !== "function" || !window.gsap) return;
    var nodes = document.querySelectorAll("audio[data-volume],audio[data-muted],audio[data-fade-in],audio[data-fade-out]");
    Array.prototype.forEach.call(nodes, function(el){
      var vol = parseFloat(el.getAttribute("data-volume")); if (!isFinite(vol)) vol = 1;
      // E02/I4 §8: o applier do renderer consome \`data-muted\` COMO o preview
      // (preview-helper: el.muted = data-muted === 'true'). O mute DOMINA o
      // gain e os fades: um clip muted produz zero sem alterar source/gain/
      // fades authored (\`data-volume\` nunca é reescrito → unmute restaura).
      var muted = el.getAttribute("data-muted") === "true";
      var gain = muted ? 0 : Math.max(0, Math.min(1, vol));
      var start = parseFloat(el.getAttribute("data-start")); if (!isFinite(start)) start = 0;
      var dur = parseFloat(el.getAttribute("data-duration"));
      var fIn = (parseFloat(el.getAttribute("data-fade-in")) || 0) / 1000;
      var fOut = (parseFloat(el.getAttribute("data-fade-out")) || 0) / 1000;
      try { window.gsap.killTweensOf(el, "volume"); } catch (e) {}
      el.muted = muted;
      el.volume = gain;
      if (!isFinite(dur) || dur <= 0) return;
      var maxFade = Math.max(0, dur - 0.5);
      if (fIn + fOut > maxFade) { var k = maxFade / (fIn + fOut); fIn *= k; fOut *= k; }
      // Envelopes lineares de amplitude, clip-local; um clip muted não gera
      // tweens (nada para rampar) e fica a zero em qualquer seek.
      if (!muted && fIn > 0) tl.fromTo(el, { volume: 0 }, { volume: gain, duration: fIn, ease: "none" }, start);
      if (!muted && fOut > 0) tl.fromTo(el, { volume: gain }, { volume: 0, duration: fOut, ease: "none" }, start + dur - fOut);
    });
  } catch (err) { /* nunca quebrar a composição por áudio */ }
}
if (typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __vpApplyAudioProps);
  else __vpApplyAudioProps();
}`;

/** Bloco <script> completo (id único, try/catch no bootstrap). */
export function buildAudioBlock(): string {
  return `<script id="${AUDIO_BLOCK_ID}">try{${AUDIO_APPLY_SOURCE}}catch(e){}</script>`;
}

/**
 * Upsert idempotente do bloco antes de </body> (substitui bloco anterior).
 * Sem </body> (fragmentos), acrescenta no fim — mesmo contrato do anim block.
 */
export function upsertAudioBlock(html: string): string {
  if (typeof html !== 'string' || !html) return html;
  const block = buildAudioBlock();
  const openIdx = html.indexOf(`<script id="${AUDIO_BLOCK_ID}"`);
  if (openIdx !== -1) {
    const closeTag = '</script>';
    const closeIdx = html.indexOf(closeTag, openIdx);
    if (closeIdx !== -1) {
      return `${html.slice(0, openIdx)}${block}${html.slice(closeIdx + closeTag.length)}`;
    }
  }
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose === -1) return html + block;
  return `${html.slice(0, bodyClose)}${block}${html.slice(bodyClose)}`;
}
