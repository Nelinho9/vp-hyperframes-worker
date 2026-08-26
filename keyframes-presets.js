/**
 * keyframes-presets — V5-P8B (§13.2): materialização GSAP de keyframes leves.
 *
 * Espelho OBRIGATÓRIO de `visttapro/src/video/v4/keyframePresets.ts`
 * (repos separados não partilham import; a paridade é garantida por
 * KEYFRAME_CANONICAL_JSON + marcadores da fonte aplicadora, testados nos
 * DOIS repos — padrão anim-presets.js/keyframePresets.ts).
 *
 * Estratégia: igual a S09/S13 — o runtime vendido (0.7.109) não interpreta
 * `data-kf`. A materialização é um ÚNICO bloco
 * `<script id="__vp-keyframes-materialized__">` antes de `</body>` com
 * conteúdo ESTÁTICO: a fonte aplicadora ES5 deriva as specs do DOM a cada
 * boot (sem payload JSON), posiciona cada tween pela janela timed mais
 * próxima (`[data-start]` — imune a /restructure), mata tweens próprias e
 * estrangeiras sobrepostas (keyframes SOBRESCREVEM presets) e adiciona as
 * novas à timeline pausada do runtime.
 *
 * Doc: docs/video-engine/V5_P8B_KEYFRAMES.md §2.1–§2.2
 */

export const KEYFRAME_ALLOWED_PROPS = ["opacity", "scale", "x", "y"];

export const KEYFRAME_MAX_KEYS = 4;
export const KEYFRAME_MIN_KEYS = 2;

export const KEYFRAME_BLOCK_ID = "__vp-keyframes-materialized__";
export const KEYFRAME_APPLY_FN_NAME = "__vpApplyKeyframes";

/** Serialização canónica — espelhada num teste do frontend (paridade CI). */
export const KEYFRAME_CANONICAL_JSON = JSON.stringify(KEYFRAME_ALLOWED_PROPS);

/**
 * Fonte aplicadora ES5 — executada (i) pelo bloco materializado no boot da
 * página e (ii) embutida no preview helper para hot-swap sem reload.
 */
export const KEYFRAME_APPLY_SOURCE = [
  "function __vpApplyKeyframes() {",
  "  var w = window;",
  "  if (!w || typeof gsap === \"undefined\") return [];",
  "  var ALLOWED = " + KEYFRAME_CANONICAL_JSON + ";",
  "  void ALLOWED;",
  "  var MOTION = { opacity: 1, x: 1, y: 1, scale: 1 };",
  "  var prev = w.__vpKeyframesApplied || [];",
  "  w.__vpKeyframesApplied = [];",
  "  for (var pi = 0; pi < prev.length; pi++) { try { prev[pi].kill(); } catch (eP) {} }",
  "  var doc = document;",
  "  var specs = [];",
  "  var els = doc.querySelectorAll(\"[data-kf]\");",
  "  for (var ei = 0; ei < els.length; ei++) {",
  "    var el0 = els[ei];",
  "    var eid = el0.id;",
  "    if (!eid || !/^[A-Za-z][\\w-]*$/.test(eid)) continue;",
  "    var raw = el0.getAttribute(\"data-kf\");",
  "    if (!raw) continue;",
  "    var arr;",
  "    try { arr = JSON.parse(raw); } catch (eJ) { continue; }",
  "    if (!Array.isArray(arr) || arr.length < 1) continue;",
  "    var frames = [];",
  "    for (var k = 0; k < arr.length; k++) {",
  "      var o = arr[k];",
  "      if (!o || typeof o.t !== \"number\" || !isFinite(o.t) || o.t < 0) continue;",
  "      var kf = { t: Math.round(o.t) };",
  "      if (typeof o.x === \"number\" && isFinite(o.x)) kf.x = o.x;",
  "      if (typeof o.y === \"number\" && isFinite(o.y)) kf.y = o.y;",
  "      if (typeof o.scale === \"number\" && isFinite(o.scale)) { var sc = o.scale; if (sc < 0.1) sc = 0.1; if (sc > 5) sc = 5; kf.scale = sc; }",
  "      if (typeof o.opacity === \"number\" && isFinite(o.opacity)) { var op = o.opacity; if (op < 0) op = 0; if (op > 1) op = 1; kf.opacity = op; }",
  "      var has = false, pk;",
  "      for (pk in kf) { if (pk !== \"t\" && MOTION[pk]) { has = true; break; } }",
  "      if (has) frames.push(kf);",
  "    }",
  "    if (!frames.length) continue;",
  "    frames.sort(function (a, b) { return a.t - b.t; });",
  "    var dedup = [], lastT = null;",
  "    for (var di = 0; di < frames.length; di++) { if (frames[di].t !== lastT) { dedup.push(frames[di]); lastT = frames[di].t; } }",
  "    frames = dedup.slice(0, " + KEYFRAME_MAX_KEYS + ");",
  "    var spec = { sel: \"#\" + eid, frames: frames };",
  "    specs.push(spec);",
  "  }",
  "  if (!specs.length) return [];",
  "  var root = doc.querySelector(\"[data-composition-id]\");",
  "  var reg = w.__timelines || (w.__timelines = {});",
  "  var cid = root ? (root.getAttribute(\"data-composition-id\") || \"\") : \"\";",
  "  var tlKey = (cid && reg[cid]) ? cid : (reg.main ? \"main\" : null);",
  "  if (!tlKey) { for (var rk in reg) { if (Object.prototype.hasOwnProperty.call(reg, rk)) { tlKey = rk; break; } } }",
  "  var tl = tlKey ? reg[tlKey] : null;",
  "  if (!tl) {",
  "    if (typeof gsap.timeline !== \"function\") return [];",
  "    tl = gsap.timeline({ paused: true });",
  "    tlKey = tlKey || cid || \"main\";",
  "    reg[tlKey] = tl;",
  "  }",
  "  function tweenKeys(t) { var ks = {}; var v = t.vars || {}; var k; for (k in v) { if (MOTION[k]) ks[k] = 1; } var sa = v.startAt; if (sa) { for (k in sa) { if (MOTION[k]) ks[k] = 1; } } return ks; }",
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
  "      var tp = tweenKeys(t), ov = false, pkK;",
  "      for (pkK in want) { if (tp[pkK]) { ov = true; break; } }",
  "      if (ov) { try { t.kill(); } catch (eK) {} }",
  "    }",
  "  }",
  "  for (var s = 0; s < specs.length; s++) {",
  "    var sp = specs[s];",
  "    var el = null; try { el = doc.querySelector(sp.sel); } catch (eQ) {}",
  "    if (!el) continue;",
  "    var host = el.closest ? el.closest(\"[data-start]\") : null;",
  "    var ws = 0, wd = null;",
  "    if (host) {",
  "      var hs = parseFloat(host.getAttribute(\"data-start\"));",
  "      if (isFinite(hs) && hs >= 0) {",
  "        ws = hs;",
  "        var hd = parseFloat(host.getAttribute(\"data-duration\"));",
  "        if (isFinite(hd) && hd > 0) wd = hd;",
  "      }",
  "    }",
  "    var wantK = {};",
  "    for (var fk = 0; fk < sp.frames.length; fk++) { var _f0 = sp.frames[fk]; var _p0; for (_p0 in _f0) { if (_p0 !== \"t\" && MOTION[_p0]) wantK[_p0] = 1; } }",
  "    killForeign(el, wantK);",
  "    for (var fi = 1; fi < sp.frames.length; fi++) {",
  "      var prevK = sp.frames[fi - 1];",
  "      var curK = sp.frames[fi];",
  "      var durS = (curK.t - prevK.t) / 1000;",
  "      if (!(durS > 0)) continue;",
  "      var posS = ws + prevK.t / 1000;",
  "      if (wd != null && posS >= ws + wd) continue;",
  "      if (wd != null && posS + durS > ws + wd) durS = Math.max(0.05, ws + wd - posS);",
  "      var fromVars = {};",
  "      if (typeof prevK.x === \"number\") fromVars.x = prevK.x;",
  "      if (typeof prevK.y === \"number\") fromVars.y = prevK.y;",
  "      if (typeof prevK.scale === \"number\") fromVars.scale = prevK.scale;",
  "      if (typeof prevK.opacity === \"number\") fromVars.opacity = prevK.opacity;",
  "      var toVars = { duration: durS, ease: \"none\" };",
  "      if (typeof curK.x === \"number\") toVars.x = curK.x;",
  "      if (typeof curK.y === \"number\") toVars.y = curK.y;",
  "      if (typeof curK.scale === \"number\") toVars.scale = curK.scale;",
  "      if (typeof curK.opacity === \"number\") toVars.opacity = curK.opacity;",
  "      var hasMotion = false, _mk;",
  "      for (_mk in toVars) { if (MOTION[_mk]) { hasMotion = true; break; } }",
  "      if (!hasMotion) continue;",
  "      try {",
  "        var tw = tl.fromTo(el, fromVars, toVars, posS);",
  "        if (tw) applied.push(tw);",
  "      } catch (eT2) {}",
  "    }",
  "  }",
  "  try { tl.time(tl.time() + 0.000001); } catch (eR) {}",
  "  w.__vpKeyframesApplied = applied;",
  "  return applied;",
  "}",
].join("\n");

const SELECTOR_SAFE_ID_RE = /^#[A-Za-z][\w-]*$/;

/**
 * @param {string|null} raw
 * @returns {Array<Record<string, unknown>>|null}
 */
export function parseKeyframeAttr(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out = [];
    for (const o of arr) {
      if (!o || typeof o.t !== "number" || !Number.isFinite(o.t) || o.t < 0) continue;
      const kf = { t: Math.round(o.t) };
      if (typeof o.x === "number" && Number.isFinite(o.x)) kf.x = o.x;
      if (typeof o.y === "number" && Number.isFinite(o.y)) kf.y = o.y;
      if (typeof o.scale === "number" && Number.isFinite(o.scale)) {
        let sc = o.scale;
        if (sc < 0.1) sc = 0.1;
        if (sc > 5) sc = 5;
        kf.scale = sc;
      }
      if (typeof o.opacity === "number" && Number.isFinite(o.opacity)) {
        let op = o.opacity;
        if (op < 0) op = 0;
        if (op > 1) op = 1;
        kf.opacity = op;
      }
      const hasProp = "x" in kf || "y" in kf || "scale" in kf || "opacity" in kf;
      if (hasProp) out.push(kf);
    }
    if (out.length === 0) return null;
    out.sort((a, b) => a.t - b.t);
    const dedup = [];
    let lastT = null;
    for (const kf of out) {
      if (kf.t !== lastT) {
        dedup.push(kf);
        lastT = kf.t;
      }
    }
    return dedup.slice(0, KEYFRAME_MAX_KEYS);
  } catch {
    return null;
  }
}

export function collectKeyframeSpecs(root) {
  const specs = [];
  if (!root || typeof root.querySelectorAll !== "function") return specs;
  const els = root.querySelectorAll("[data-kf]");
  for (const el of els) {
    const id = el.id;
    if (!id || !SELECTOR_SAFE_ID_RE.test(`#${id}`)) continue;
    const raw = el.getAttribute("data-kf");
    const frames = parseKeyframeAttr(raw);
    if (!frames || frames.length === 0) continue;
    specs.push({ sel: `#${id}`, frames });
  }
  return specs;
}

export function buildKeyframeBlock(specs) {
  void specs;
  return `<script id="${KEYFRAME_BLOCK_ID}">${KEYFRAME_APPLY_SOURCE};${KEYFRAME_APPLY_FN_NAME}();</script>`;
}

const KEYFRAME_BLOCK_RE = new RegExp(
  `<script id="${KEYFRAME_BLOCK_ID}">[\\s\\S]*?<\\/script>`,
  "i",
);

export function upsertKeyframeBlock(html, specs) {
  if (typeof html !== "string") return html;
  const stripped = html.replace(KEYFRAME_BLOCK_RE, "");
  if (!Array.isArray(specs) || specs.length === 0) return stripped;
  const block = buildKeyframeBlock(specs);
  const bodyClose = stripped.search(/<\/body>/i);
  if (bodyClose === -1) return stripped + block;
  return stripped.slice(0, bodyClose) + block + stripped.slice(bodyClose);
}

export function touchesKeyframeProps(patches) {
  if (!Array.isArray(patches)) return false;
  return patches.some((p) => String(p?.property ?? "") === "keyframes");
}
