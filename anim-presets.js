/**
 * anim-presets — V5-P1D (§6.4): presets de animação entrada/saída
 * materializados em tweens GSAP reais no HTML persistido.
 *
 * Espelho OBRIGATÓRIO de `visttapro/src/video/v4/animPresets.ts` (repos
 * separados não partilham import; a paridade é garantida por
 * ANIM_TWEENS_CANONICAL_JSON + marcadores da fonte aplicadora, testados nos
 * DOIS repos — padrão prop-map.js/propMap.ts).
 *
 * Estratégia §6.4: nem o runtime vendido (0.7.109) nem o CLI interpretam os
 * atributos `data-anim-*` transportados desde V5-P1A. A materialização é um
 * ÚNICO bloco `<script id="__vp-anim-materialized__">` antes de `</body>` —
 * conteúdo ESTÁTICO (a fonte aplicadora deriva as specs do DOM em cada
 * execução) que posiciona cada tween EM RUNTIME pela janela timed mais
 * próxima (`[data-start]` — inclui autostamp), tornando o bloco imune a
 * /restructure, e aplica kills determinísticos antes de adicionar: próprios
 * tweens anteriores (`__vpAnimApplied`) e "estrangeiros" authored no mesmo
 * elemento∩props de movimento.
 *
 * Preview↔render coerentes por construção: ambos consomem o MESMO documento
 * (tweens GSAP reais; o CLI injeta apenas o seu runtime).
 *
 * Doc: docs/video-engine/V5_P1D_ANIMACOES_INSPECTOR.md §2
 */

/**
 * Tabela canónica de presets (§2.1). Só transform + opacity — NUNCA
 * left/top/display/visibility (lint `gsap_non_transform_motion`; o runtime é
 * dono dessas props). Semântica direcional: slideLeft entra deslizando para
 * a esquerda; slideRight sai para a direita.
 *
 * @type {{ in: Record<string, {from?: Record<string, number>, to: Record<string, number|string>, ease: string}>, out: Record<string, {to: Record<string, number|string>, ease: string}> }}
 */
export const ANIM_TWEENS = {
  in: {
    fade: { from: { opacity: 0 }, to: { opacity: 1 }, ease: "power2.out" },
    riseIn: { from: { opacity: 0, y: 40 }, to: { opacity: 1, y: 0 }, ease: "power2.out" },
    zoomIn: { from: { opacity: 0, scale: 0.85 }, to: { opacity: 1, scale: 1 }, ease: "power2.out" },
    slideLeft: { from: { opacity: 0, x: 60 }, to: { opacity: 1, x: 0 }, ease: "power2.out" },
    popIn: { from: { opacity: 0, scale: 0.5 }, to: { opacity: 1, scale: 1 }, ease: "back.out(1.8)" },
  },
  out: {
    fade: { to: { opacity: 0 }, ease: "power2.in" },
    sinkOut: { to: { opacity: 0, y: 30 }, ease: "power2.in" },
    zoomOut: { to: { opacity: 0, scale: 1.12 }, ease: "power2.in" },
    slideRight: { to: { opacity: 0, x: 60 }, ease: "power2.in" },
  },
};

/** Duração/atraso default quando os atributos não existem (ms). */
export const ANIM_DEFAULT_DUR_MS = 600;

/** Serialização canónica — espelhada num teste do frontend (paridade CI). */
export const ANIM_TWEENS_CANONICAL_JSON = JSON.stringify(ANIM_TWEENS);

/** Id do bloco materializado (upsert idempotente). */
export const ANIM_BLOCK_ID = "__vp-anim-materialized__";

/**
 * Fonte aplicadora ES5 — executada (i) pelo bloco materializado no boot da
 * página e (ii) embutida no preview helper para hot-swap sem reload.
 * DERIVA as specs do PRÓPRIO DOM a cada execução (`[data-anim-in/out]` +
 * tabela), resolve posições pela janela timed mais próxima, mata os tweens
 * anteriores/conflitantes e adiciona os novos à timeline registada. O bloco
 * persistido é assim ESTÁTICO (sem payload) e nunca diverge dos atributos.
 * Retorna os tweens aplicados ([] quando gsap ausente/nada a aplicar).
 */
export const ANIM_APPLY_SOURCE = [
  "function __vpApplyAnimations() {",
  "  var w = window;",
  "  if (!w || typeof gsap === 'undefined') return [];",
  "  var T = " + ANIM_TWEENS_CANONICAL_JSON + ";",
  "  var MOTION = { opacity: 1, x: 1, y: 1, scale: 1 };",
  "  var prev = w.__vpAnimApplied || [];",
  "  w.__vpAnimApplied = [];",
  "  for (var pi = 0; pi < prev.length; pi++) { try { prev[pi].kill(); } catch (eP) {} }",
  "  var doc = document;",
  "  var specs = [];",
  "  var els = doc.querySelectorAll('[data-anim-in],[data-anim-out]');",
  "  for (var ei = 0; ei < els.length; ei++) {",
  "    var el0 = els[ei];",
  "    var eid = el0.id;",
  "    if (!eid || !/^[A-Za-z][\\w-]*$/.test(eid)) continue;",
  "    var ain = el0.getAttribute('data-anim-in');",
  "    var aout = el0.getAttribute('data-anim-out');",
  "    var durr = parseFloat(el0.getAttribute('data-anim-dur-ms'));",
  "    var delr = parseFloat(el0.getAttribute('data-anim-delay-ms'));",
  "    var sp0 = { sel: '#' + eid };",
  "    if (ain && T.in[ain]) sp0.in = ain;",
  "    if (aout && T.out[aout]) sp0.out = aout;",
  "    if (isFinite(durr) && durr > 0) sp0.dur = durr;",
  "    if (isFinite(delr) && delr > 0) sp0.delay = delr;",
  "    if (sp0.in || sp0.out) specs.push(sp0);",
  "  }",
  "  if (!specs.length) return [];",
  "  var root = doc.querySelector('[data-composition-id]');",
  "  var reg = w.__timelines || (w.__timelines = {});",
  "  var cid = root ? (root.getAttribute('data-composition-id') || '') : '';",
  "  var tlKey = (cid && reg[cid]) ? cid : (reg.main ? 'main' : null);",
  "  if (!tlKey) { for (var rk in reg) { if (Object.prototype.hasOwnProperty.call(reg, rk)) { tlKey = rk; break; } } }",
  "  var tl = tlKey ? reg[tlKey] : null;",
  "  if (!tl) {",
  "    if (typeof gsap.timeline !== 'function') return [];",
  "    tl = gsap.timeline({ paused: true });",
  "    tlKey = tlKey || cid || 'main';",
  "    reg[tlKey] = tl;",
  "  }",
  "  var rootDur = null;",
  "  if (root) { var rd = parseFloat(root.getAttribute('data-duration')); if (isFinite(rd) && rd > 0) rootDur = rd; }",
  "  function presetKeys(p) { var ks = {}; var k; for (k in p.from) { if (MOTION[k]) ks[k] = 1; } for (k in p.to) { if (MOTION[k]) ks[k] = 1; } return ks; }",
  "  function tweenKeys(t) { var ks = {}; var v = t.vars || {}; var k; for (k in v) { if (MOTION[k]) ks[k] = 1; } var sa = v.startAt; if (sa) { for (k in sa) { if (MOTION[k]) ks[k] = 1; } } return ks; }",
  "  function merged(a, b) { var o = {}; var k; for (k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k]; } for (k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k]; } return o; }",
  "  var applied = [];",
  "  function killForeign(el, want) {",
  "    var kids; try { kids = tl.getChildren(false, true, false); } catch (eG) { return; }",
  "    for (var i = 0; i < kids.length; i++) {",
  "      var t = kids[i];",
  "      if (applied.indexOf(t) !== -1) continue;",
  "      var targets; try { targets = t.targets ? t.targets() : null; } catch (eT) { continue; }",
  "      if (!targets) continue;",
  "      var hit = false, j;",
  "      for (j = 0; j < targets.length; j++) { if (targets[j] === el) { hit = true; break; } }",
  "      if (!hit) continue;",
  "      var tp = tweenKeys(t), ov = false, pk;",
  "      for (pk in want) { if (tp[pk]) { ov = true; break; } }",
  "      if (ov) { try { t.kill(); } catch (eK) {} }",
  "    }",
  "  }",
  "  for (var s = 0; s < specs.length; s++) {",
  "    var sp = specs[s];",
  "    var el = null; try { el = doc.querySelector(sp.sel); } catch (eQ) {}",
  "    if (!el) continue;",
  "    var host = el.closest ? el.closest('[data-start]') : null;",
  "    var ws = 0, wd = null;",
  "    if (host) {",
  "      var hs = parseFloat(host.getAttribute('data-start'));",
  "      if (isFinite(hs) && hs >= 0) {",
  "        ws = hs;",
  "        var hd = parseFloat(host.getAttribute('data-duration'));",
  "        if (isFinite(hd) && hd > 0) wd = hd;",
  "      }",
  "    }",
  "    var durMs = (isFinite(sp.dur) && sp.dur > 0) ? sp.dur : " + String(ANIM_DEFAULT_DUR_MS) + ";",
  "    var delayMs = (isFinite(sp.delay) && sp.delay > 0) ? sp.delay : 0;",
  "    if (sp.in && T.in[sp.in]) {",
  "      var pinT = T.in[sp.in], posIn = ws + delayMs / 1000, din = durMs / 1000;",
  "      if (wd != null && posIn + din > ws + wd) din = Math.max(0.05, ws + wd - posIn);",
  "      if (!(wd != null && posIn >= ws + wd)) {",
  "        killForeign(el, presetKeys(pinT));",
  "        try {",
  "          var twIn = tl.fromTo(el, merged({}, pinT.from), merged(pinT.to, { duration: din, ease: pinT.ease }), posIn);",
  "          if (twIn) { applied.push(twIn); }",
  "        } catch (eI) {}",
  "      }",
  "    }",
  "    if (sp.out && T.out[sp.out]) {",
  "      var poutT = T.out[sp.out], dout = durMs / 1000, posOut = null;",
  "      if (wd != null) posOut = ws + wd - dout;",
  "      else if (rootDur != null) posOut = rootDur - dout;",
  "      if (posOut != null) {",
  "        if (posOut < ws) posOut = ws;",
  "        killForeign(el, presetKeys(poutT));",
  "        try {",
  "          var twOut = tl.to(el, merged(poutT.to, { duration: dout, ease: poutT.ease }), posOut);",
  "          if (twOut) { applied.push(twOut); }",
  "        } catch (eO) {}",
  "      }",
  "    }",
  "  }",
  "  try { tl.time(tl.time() + 0.000001); } catch (eR) {}",
  "  w.__vpAnimApplied = applied;",
  "  return applied;",
  "}",
].join("\n");

/** Nome global da função aplicadora (bloco materializado). */
export const ANIM_APPLY_FN_NAME = "__vpApplyAnimations";

// ─── Coleta + upsert do bloco ────────────────────────────────────────────────

const SELECTOR_SAFE_ID_RE = /^#[A-Za-z][\w-]*$/;

/**
 * Deriva as specs de animação de um documento/elemento (linkedom no worker,
 * jsdom no app). Chaves em ordem fixa → serialização determinística.
 * Elementos sem id ou com presets inválidos/'none' são ignorados.
 *
 * @param {Document|Element} root DOM enraizado na composição.
 * @returns {Array<{sel: string, in?: string, out?: string, dur?: number, delay?: number}>}
 */
export function collectAnimSpecs(root) {
  /** @type {Array<Record<string, unknown>>} */
  const specs = [];
  if (!root || typeof root.querySelectorAll !== "function") return specs;
  const els = root.querySelectorAll("[data-anim-in],[data-anim-out]");
  for (const el of els) {
    const id = el.id;
    if (!id || !SELECTOR_SAFE_ID_RE.test(`#${id}`)) continue;
    const aIn = el.getAttribute("data-anim-in");
    const aOut = el.getAttribute("data-anim-out");
    const durRaw = parseFloat(el.getAttribute("data-anim-dur-ms"));
    const delayRaw = parseFloat(el.getAttribute("data-anim-delay-ms"));
    /** @type {Record<string, unknown>} */
    const spec = { sel: `#${id}` };
    if (aIn && ANIM_TWEENS.in[aIn]) spec.in = aIn;
    if (aOut && ANIM_TWEENS.out[aOut]) spec.out = aOut;
    if (Number.isFinite(durRaw) && durRaw > 0) spec.dur = durRaw;
    if (Number.isFinite(delayRaw) && delayRaw > 0) spec.delay = delayRaw;
    if (spec.in || spec.out) specs.push(spec);
  }
  return specs;
}

/**
 * Constrói o bloco materializado — conteúdo ESTÁTICO (fonte aplicadora +
 * invocação; as specs derivam do DOM em runtime, §2.2).
 *
 * @param {Array<Record<string, unknown>>} specs (apenas sinaliza presença)
 * @returns {string}
 */
export function buildAnimBlock(specs) {
  void specs;
  return `<script id="${ANIM_BLOCK_ID}">${ANIM_APPLY_SOURCE};${ANIM_APPLY_FN_NAME}();</script>`;
}

const ANIM_BLOCK_RE = new RegExp(
  `<script id="${ANIM_BLOCK_ID}">[\\s\\S]*?<\\/script>`,
  "i",
);

/**
 * Upsert idempotente do bloco materializado: remove o bloco anterior e insere
 * o novo antes de `</body>`. Zero specs → só remove (HTML limpo).
 * Convergência byte-exata garantida pela derivação determinística das specs.
 *
 * @param {string} html HTML completo da composição.
 * @param {Array<Record<string, unknown>>} specs
 * @returns {string}
 */
export function upsertAnimBlock(html, specs) {
  if (typeof html !== "string") return html;
  const stripped = html.replace(ANIM_BLOCK_RE, "");
  if (!Array.isArray(specs) || specs.length === 0) return stripped;
  const block = buildAnimBlock(specs);
  const bodyClose = stripped.search(/<\/body>/i);
  if (bodyClose === -1) return stripped + block;
  return stripped.slice(0, bodyClose) + block + stripped.slice(bodyClose);
}

/**
 * True quando uma lista de patches toca props de animação (gatilho da
 * materialização — batches mecânicos não alteram o HTML além da patch).
 *
 * @param {Array<{property?: string}>} patches
 * @returns {boolean}
 */
export function touchesAnimProps(patches) {
  if (!Array.isArray(patches)) return false;
  return patches.some((p) => /^anim(In|Out|DurMs|DelayMs)$/.test(String(p?.property ?? "")));
}
