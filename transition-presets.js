/**
 * transition-presets — V5-P2C (§7.2): presets de transição entre cenas
 * materializados em tweens GSAP reais no HTML persistido.
 *
 * Espelho OBRIGATÓRIO de `visttapro/src/video/v4/transitionPresets.ts` (repos
 * separados não partilham import; a paridade é garantida por
 * TRANSITIONS_CANONICAL_JSON + marcadores da fonte aplicadora, testados nos
 * DOIS repos — padrão prop-map.js/propMap.ts e anim-presets.js/animPresets.ts).
 *
 * Estratégia (§2.5 da spec): nem o runtime vendido (0.7.109) nem o CLI
 * interpretam os atributos `data-transition-out/in` escritos pelo
 * `/restructure`. A materialização é um ÚNICO bloco estático
 * `<script id="__vp-transitions-materialized__">` antes de `</body>` cuja
 * fonte aplicadora ES5 DERIVA as specs do DOM a cada execução e posiciona os
 * tweens pela janela timed do PRÓPRIO clip (`data-start`/`data-duration`) —
 * imune a /restructure, coerente preview↔render por construção.
 *
 * Geometria das janelas (§2.4): o clip saínte tem a janela EXTENDIDA o
 * overlap; o entrante começa intacto na fronteira k_{i+1} — o crossfade vive
 * dentro da duração total existente (root inalterada). O lint
 * (`window-lint.js`) isenta exatamente esse overlap declarado.
 *
 * Doc: docs/video-engine/V5_P2C_TRANSICOES.md §2
 */

/**
 * Tabela canónica de presets (§2.5). Só opacity/transform/clipPath/filter —
 * NUNCA left/top/display/visibility (lint `gsap_non_transform_motion`; o
 * runtime é dono dessas props). Kinds sem lado `out` deixam o saínte parado
 * por baixo (wipe/slide cobrem-no).
 *
 * @type {Record<string, { out?: { to: Record<string, number|string>, ease: string }, in?: { from: Record<string, number|string>, to: Record<string, number|string>, ease: string } }>}
 */
export const TRANSITION_TWEENS = {
  fade: {
    out: { to: { opacity: 0 }, ease: "power1.inOut" },
    in: { from: { opacity: 0 }, to: { opacity: 1 }, ease: "power1.inOut" },
  },
  dissolve: {
    out: { to: { opacity: 0 }, ease: "none" },
    in: { from: { opacity: 0 }, to: { opacity: 1 }, ease: "none" },
  },
  wipeLeft: {
    in: {
      from: { clipPath: "inset(0 100% 0 0)" },
      to: { clipPath: "inset(0 0% 0 0)" },
      ease: "power2.inOut",
    },
  },
  wipeRight: {
    in: {
      from: { clipPath: "inset(0 0% 0 100%)" },
      to: { clipPath: "inset(0 0% 0 0%)" },
      ease: "power2.inOut",
    },
  },
  slide: {
    in: { from: { xPercent: 100 }, to: { xPercent: 0 }, ease: "power2.inOut" },
  },
  zoomBlur: {
    out: { to: { opacity: 0, scale: 0.94 }, ease: "power1.in" },
    in: {
      from: { opacity: 0, scale: 1.08, filter: "blur(8px)" },
      to: { opacity: 1, scale: 1, filter: "blur(0px)" },
      ease: "power1.out",
    },
  },
};

/** Duração canónica mínima/máxima (ms) — clamp em TODOS os escritores. */
export const TRANSITION_DURATION_MIN_MS = 200;
export const TRANSITION_DURATION_MAX_MS = 800;

/** Serialização canónica — espelhada num teste do frontend (paridade CI). */
export const TRANSITIONS_CANONICAL_JSON = JSON.stringify(TRANSITION_TWEENS);

/** Id do bloco materializado (upsert idempotente). */
export const TRANSITION_BLOCK_ID = "__vp-transitions-materialized__";

/** Nome global da função aplicadora (bloco materializado). */
export const TRANSITION_APPLY_FN_NAME = "__vpApplyTransitions";

const TRANSITION_ATTR_RE = /^([A-Za-z]\w*)@(\d+(?:\.\d+)?)$/;

/**
 * Parse canónico do atributo `"kind@ms"`: devolve `{kind, durationMs}` com a
 * duração CLAMPADA a [TRANSITION_DURATION_MIN_MS, TRANSITION_DURATION_MAX_MS],
 * ou null quando malformado/kind desconhecido. Fonte única para o lint, a
 * normalização de staging e a materialização.
 *
 * @param {string|null|undefined} raw Valor bruto do atributo.
 * @returns {{ kind: string, durationMs: number } | null}
 */
export function parseTransitionAttr(raw) {
  if (typeof raw !== "string") return null;
  const m = TRANSITION_ATTR_RE.exec(raw);
  if (!m) return null;
  const preset = TRANSITION_TWEENS[m[1]];
  if (!preset) return null;
  const ms = parseFloat(m[2]);
  if (!Number.isFinite(ms)) return null;
  return {
    kind: m[1],
    durationMs: Math.min(
      TRANSITION_DURATION_MAX_MS,
      Math.max(TRANSITION_DURATION_MIN_MS, Math.round(ms)),
    ),
  };
}

/**
 * Fonte aplicadora ES5 — executada pelo bloco materializado no boot da
 * página. DERIVA as specs do PRÓPRIO DOM a cada execução
 * (`[data-transition-in/out]`), posiciona cada tween pela janela timed do
 * próprio clip, mata APENAS os seus próprios tweens anteriores
 * (`__vpTransitionsApplied`) e adiciona os novos à timeline registada
 * (mesma resolução de registry do bloco P1D). Retorna os tweens aplicados
 * ([] quando gsap ausente/nada a aplicar).
 */
export const TRANSITION_APPLY_SOURCE = [
  "function __vpApplyTransitions() {",
  "  var w = window;",
  "  if (!w || typeof gsap === 'undefined') return [];",
  "  var T = " + TRANSITIONS_CANONICAL_JSON + ";",
  "  var MIN = " + String(TRANSITION_DURATION_MIN_MS) + ", MAX = " + String(TRANSITION_DURATION_MAX_MS) + ";",
  "  var prev = w.__vpTransitionsApplied || [];",
  "  w.__vpTransitionsApplied = [];",
  "  for (var pi = 0; pi < prev.length; pi++) { try { prev[pi].kill(); } catch (eP) {} }",
  "  var doc = document;",
  "  var els = doc.querySelectorAll('[data-transition-in],[data-transition-out]');",
  "  if (!els.length) return [];",
  "  var root = doc.querySelector('[data-composition-id]');",
  "  var reg = w.__timelines || (w.__timelines = {});",
  "  var cid = root ? (root.getAttribute('data-composition-id') || '') : '';",
  "  var tlKey = (cid && reg[cid]) ? cid : (reg.main ? 'main' : null);",
  "  if (!tlKey) { for (var rk in reg) { if (Object.prototype.hasOwnProperty.call(reg, rk)) { tlKey = rk; break; } } }",
  "  var tl = tlKey ? reg[tlKey] : null;",
  "  if (!tl) {",
  "    if (typeof gsap.timeline !== 'function') return [];",
  "    tl = gsap.timeline({ paused: true });",
  "    reg[tlKey || cid || 'main'] = tl;",
  "  }",
  "  function parseAttr(raw) {",
  "    if (!raw) return null;",
  "    var m = /^([A-Za-z]\\w*)@(\\d+(?:\\.\\d+)?)$/.exec(raw);",
  "    if (!m) return null;",
  "    var preset = T[m[1]];",
  "    if (!preset) return null;",
  "    var ms = parseFloat(m[2]);",
  "    if (!(ms >= MIN)) ms = MIN;",
  "    if (ms > MAX) ms = MAX;",
  "    return { preset: preset, ms: Math.round(ms) };",
  "  }",
  "  function merged(a, b) { var o = {}; var k; for (k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k]; } for (k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k]; } return o; }",
  "  function cloned(a) { return merged(a, {}); }",
  "  var applied = [];",
  "  for (var i = 0; i < els.length; i++) {",
  "    var el = els[i];",
  "    var ws = parseFloat(el.getAttribute('data-start'));",
  "    var wd = parseFloat(el.getAttribute('data-duration'));",
  "    if (!isFinite(ws) || ws < 0 || !isFinite(wd) || wd <= 0) continue;",
  "    var pin = parseAttr(el.getAttribute('data-transition-in'));",
  "    if (pin && pin.preset.in) {",
  "      var P = pin.preset.in, din = pin.ms / 1000;",
  "      if (din > wd) din = wd;",
  "      try {",
  "        var twIn = tl.fromTo(el, cloned(P.from), merged(P.to, { duration: din, ease: P.ease }), ws);",
  "        if (twIn) applied.push(twIn);",
  "      } catch (eI) {}",
  "    }",
  "    var pout = parseAttr(el.getAttribute('data-transition-out'));",
  "    if (pout && pout.preset.out) {",
  "      var Q = pout.preset.out, dout = pout.ms / 1000;",
  "      if (dout > wd) dout = wd;",
  "      var posOut = ws + wd - dout;",
  "      if (posOut < ws) posOut = ws;",
  "      try {",
  "        var twOut = tl.to(el, merged(Q.to, { duration: dout, ease: Q.ease }), posOut);",
  "        if (twOut) applied.push(twOut);",
  "      } catch (eO) {}",
  "    }",
  "  }",
  "  try { tl.time(tl.time() + 0.000001); } catch (eR) {}",
  "  w.__vpTransitionsApplied = applied;",
  "  return applied;",
  "}",
].join("\n");

// ─── Coleta + upsert do bloco ────────────────────────────────────────────────

const SELECTOR_SAFE_ID_RE = /^#[A-Za-z][\w-]*$/;

/**
 * Deriva as specs de transição de um documento/elemento (linkedom no worker,
 * jsdom no app). Chaves em ordem fixa → serialização determinística.
 * Elementos sem id, com kinds inválidos ou atributos malformados são
 * ignorados.
 *
 * @param {Document|Element} root DOM enraizado na composição.
 * @returns {Array<{sel: string, in?: string, inMs?: number, out?: string, outMs?: number}>}
 */
export function collectTransitionSpecs(root) {
  /** @type {Array<Record<string, unknown>>} */
  const specs = [];
  if (!root || typeof root.querySelectorAll !== "function") return specs;
  const els = root.querySelectorAll("[data-transition-in],[data-transition-out]");
  for (const el of els) {
    const id = el.id;
    if (!id || !SELECTOR_SAFE_ID_RE.test(`#${id}`)) continue;
    /** @type {Record<string, unknown>} */
    const spec = { sel: `#${id}` };
    const aIn = parseTransitionAttr(el.getAttribute("data-transition-in"));
    if (aIn && TRANSITION_TWEENS[aIn.kind].in) {
      spec.in = aIn.kind;
      spec.inMs = aIn.durationMs;
    }
    const aOut = parseTransitionAttr(el.getAttribute("data-transition-out"));
    if (aOut && TRANSITION_TWEENS[aOut.kind].out) {
      spec.out = aOut.kind;
      spec.outMs = aOut.durationMs;
    }
    if (spec.in !== undefined || spec.out !== undefined) specs.push(spec);
  }
  return specs;
}

/**
 * Constrói o bloco materializado — conteúdo ESTÁTICO (fonte aplicadora +
 * invocação; as specs derivam do DOM em runtime).
 *
 * @param {Array<Record<string, unknown>>} specs (apenas sinaliza presença)
 * @returns {string}
 */
export function buildTransitionBlock(specs) {
  void specs;
  return `<script id="${TRANSITION_BLOCK_ID}">${TRANSITION_APPLY_SOURCE};${TRANSITION_APPLY_FN_NAME}();</script>`;
}

const TRANSITION_BLOCK_RE = new RegExp(
  `<script id="${TRANSITION_BLOCK_ID}">[\\s\\S]*?<\\/script>`,
  "i",
);

/**
 * Upsert idempotente do bloco materializado: remove o bloco anterior e insere
 * o novo antes de `</body>`. Zero specs → só remove (HTML limpo).
 *
 * @param {string} html HTML completo da composição.
 * @param {Array<Record<string, unknown>>} specs
 * @returns {string}
 */
export function upsertTransitionBlock(html, specs) {
  if (typeof html !== "string") return html;
  const stripped = html.replace(TRANSITION_BLOCK_RE, "");
  if (!Array.isArray(specs) || specs.length === 0) return stripped;
  const block = buildTransitionBlock(specs);
  const bodyClose = stripped.search(/<\/body>/i);
  if (bodyClose === -1) return stripped + block;
  return stripped.slice(0, bodyClose) + block + stripped.slice(bodyClose);
}
