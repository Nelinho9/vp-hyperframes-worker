/**
 * elements-registry — V5-P3A (§8.1, AD-5) + F05 (V5.34 composições/camadas).
 *
 * É a cola editor↔assets↔chat↔quality: S16 serve GET /elements a partir
 * deste artefacto, S17 lista assets usados, P4 consome-o nas tools do chat e
 * P6 alimenta o quality gate. Publicado EM CADA PERSIST (staging pelo próprio
 * worker; /patch e /restructure cavalgam a resposta e o caller persiste —
 * mesmas regras do HTML em V4-04C).
 *
 * Contrato v1 (docs/video-engine/V5_P3A_ELEMENTS_REGISTRY.md §2):
 *   { version: 1, elements: [{ id, type, sceneId, text?, srcAssetUrl?,
 *                              animIn?, animOut?, bboxAtSceneStart? }] }
 * Campos opcionais são OMITIDOS quando não se aplicam ("não lido do DOM" ≠
 * valor neutro); ordem de documento; dedup de id (primeira ocorrência ganha).
 *
 * Contrato v2 (F05 — C5/C6):
 *   { version: 2, compositionId, revision: number|null, elements: [V2Entry],
 *     conflicts: [{ id, firstIndex, duplicateIndex }] }
 * V2Entry = v1 + { compositionId, parentId, order, orderInParent, label, role,
 *   hidden, locked, z, scope, bboxSource, assetRef, assetProvenance,
 *   hasSignedUrl, typeProvenance, capabilities, start, duration, mediaOffset }.
 * HTML continua canónico; o registry é vista derivada versionada, nunca um
 * segundo modelo concorrente. Leitura v1 preservada via adaptV1RegistryToV2 /
 * normalizeRegistry. IDs duplicados geram conflito identificado, nunca dedup
 * silencioso (o primeiro vence no inventário, o conflito fica explícito).
 * Locked é flag do editor sem efeito visual; hidden é alteração visual
 * persistida (data-hidden + display:none) sem sair do registry. Áudio global
 * (sceneId null + type audio) tem scope "composition", nunca é descartado.
 * Group/shape nunca são coagidos a text: data-element-type explícito e tokens
 * reservados têm precedência; o fallback text fica marcado como
 * typeProvenance "fallback" e editableAsText só aí é true para text.
 * assetRef é a identidade canónica SEM query/fragment (URLs assinadas nunca
 * são identidade); srcAssetUrl v1 mantido por compatibilidade com
 * hasSignedUrl explícito. bbox sem layout é best-effort
 * (bboxSource "authored-best-effort") distinguida de "unmeasured".
 *
 * Derivação SEM layout: linkedom não mede caixas — `bboxAtSceneStart` é
 * best-effort a partir do estilo inline (authored px + deltas `--el-*`
 * escritos pela geometria V5-P0B).
 */

import { parseHTML } from "linkedom";
import { readAuthoredMargin } from './geometry-layout.js';

export const ELEMENTS_VERSION = 2;
export const ELEMENTS_V1 = 1;

const ARTIFACTS_BUCKET = "video-artifacts";

/** Orchestrator project ids are UUIDs; internal/test ids are skipped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage path of the derived element registry for a project. */
export function elementsStoragePath(projectId) {
  return `projects/${projectId}/compositions/elements.json`;
}

/**
 * Prefixos de id → tipo. Os três primeiros grupos espelham `inferElementType`
 * do editor (previewProtocol.ts); `group`/`shape` são reservados do contrato
 * §8.1 e ainda não emitidos pelo editor.
 */
const PREFIX_TYPES = [
  [/^(img|image)$/, "image"],
  [/^(audio|voice|music|sfx)$/, "audio"],
  [/^(video|footage)$/, "video"],
  [/^(group|grp)$/, "group"],
  [/^(shape)$/, "shape"],
];

/**
 * V5-P3B: forma ESTÁVEL `scene-N-{type}-K[-copy-M]` — o token do tipo é o 3.º
 * segmento (`scene-1-img-1` → image). A cauda `-copy-M` é a duplicação V5-P1E.
 * Devolve null quando o id não está na forma (cai à inferência por prefixo).
 */
const STABLE_ID_RE = /^scene-\d+-([a-z]+)-\d+(?:-copy-\d+)*$/;

function stableIdType(id) {
  const m = STABLE_ID_RE.exec(id || "");
  if (!m) return null;
  for (const [re, type] of PREFIX_TYPES) {
    if (re.test(m[1])) return type;
  }
  return m[1] === "text" ? "text" : null;
}

/** Effective element id: authored `id` wins over the runtime's `data-hf-id`. */
function effectiveId(el) {
  return el.id || el.getAttribute("data-hf-id") || "";
}

/** First `url(...)` of an inline background-image declaration ('' se nenhuma). */
function backgroundImageUrl(styleAttr) {
  if (!styleAttr) return "";
  const m = styleAttr.match(/background-image\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/i);
  return m ? m[2] : "";
}

function hasSvgAncestor(el) {
  let node = el.parentNode;
  while (node && typeof node.tagName === "string") {
    if (node.tagName.toLowerCase() === "svg") return true;
    node = node.parentNode;
  }
  return false;
}

/**
 * F05: inferência de tipo com proveniência explícita e sem coercion
 * group/shape→text. Ordem: data-element-type explícito → token estável →
 * prefixo → tag → svg → background → fallback text (marcado).
 */
function inferTypeV2(el) {
  const explicit = (el.getAttribute("data-element-type") || "").trim().toLowerCase();
  if (explicit === "text" || explicit === "image" || explicit === "video" || explicit === "audio" || explicit === "group" || explicit === "shape") {
    return { type: explicit, provenance: "explicit" };
  }
  const id = effectiveId(el);
  const stable = stableIdType(id);
  if (stable) return { type: stable, provenance: "stable" };
  const prefix = (id.split("-")[0] || "").toLowerCase();
  for (const [re, type] of PREFIX_TYPES) {
    if (re.test(prefix)) return { type, provenance: "prefix" };
  }
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "img") return { type: "image", provenance: "tag" };
  if (tag === "video") return { type: "video", provenance: "tag" };
  if (tag === "audio") return { type: "audio", provenance: "tag" };
  if (tag === "svg") return { type: "shape", provenance: "tag" };
  if (hasSvgAncestor(el)) return { type: "shape", provenance: "svg" };
  if (backgroundImageUrl(el.getAttribute("style"))) return { type: "image", provenance: "background" };
  return { type: "text", provenance: "fallback" }; // mesmo fallback do editor (inferElementType)
}

/** Nearest ancestor `.clip` id (walk manual: nunca o próprio elemento). */
function nearestSceneId(el) {
  let node = el.parentNode;
  while (node && typeof node.classList !== "undefined") {
    let isClip = false;
    try {
      isClip = Boolean(node.classList && node.classList.contains("clip"));
    } catch {
      isClip = false;
    }
    if (isClip) return effectiveId(node) || null;
    node = node.parentNode;
  }
  return null;
}

/** Nearest ancestor element id (parentId F05; null quando não há). */
function nearestParentId(el) {
  let node = el.parentNode;
  while (node && typeof node.getAttribute === "function") {
    const pid = effectiveId(node);
    if (pid) return pid;
    if (node.tagName && String(node.tagName).toLowerCase() === "html") return null;
    node = node.parentNode;
    if (!node || typeof node.tagName !== "string") return null;
  }
  return null;
}

/** Authored px value of one inline declaration (missing/non-numeric → null). */
function declPx(styleAttr, prop) {
  if (!styleAttr) return null;
  const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]*)`, "i");
  const m = styleAttr.match(re);
  if (!m) return null;
  const n = parseFloat(m[2]);
  return Number.isFinite(n) ? n : null;
}

/** Delta px stored in a `--el-*` geometry var (V5-P0B; missing → null). */
function geomVarPx(styleAttr, name) {
  if (!styleAttr) return null;
  const m = styleAttr.match(new RegExp(`${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  return m ? parseFloat(m[1]) : null;
}

/**
 * Best-effort bbox sem layout: width/height das vars `--el-w/h` com fallback
 * ao inline; x/y = baseline authored (`left/top` px) + delta da var. Componentes
 * não resolúveis são omitidos; devolve null quando nada é numérico.
 */
function bboxAtSceneStart(styleAttr) {
  if (!styleAttr) return null;
  const bbox = {};
  const w = geomVarPx(styleAttr, "--el-w") ?? declPx(styleAttr, "width");
  const h = geomVarPx(styleAttr, "--el-h") ?? declPx(styleAttr, "height");
  const left = declPx(styleAttr, "left");
  const top = declPx(styleAttr, "top");
  const dx = geomVarPx(styleAttr, "--el-x");
  const dy = geomVarPx(styleAttr, "--el-y");
  if (Number.isFinite(w)) bbox.width = w;
  if (Number.isFinite(h)) bbox.height = h;
  const mx = geomVarPx(styleAttr, '--el-margin-x') ?? readAuthoredMargin(styleAttr, 'left').pixels;
  const my = geomVarPx(styleAttr, '--el-margin-y') ?? readAuthoredMargin(styleAttr, 'top').pixels;
  if (mx !== null && (Number.isFinite(left) || Number.isFinite(dx))) bbox.x = (left || 0) + (dx || 0) + mx;
  if (my !== null && (Number.isFinite(top) || Number.isFinite(dy))) bbox.y = (top || 0) + (dy || 0) + my;
  return Object.keys(bbox).length > 0 ? bbox : null;
}

/** Root-owned `.clip` = cena (unidade da timeline, fora do inventário). */
function isRootOwnedSceneClip(el, root) {
  let hasClipClass = false;
  try {
    hasClipClass = Boolean(el.classList && el.classList.contains("clip"));
  } catch {
    return false;
  }
  if (!hasClipClass) return false;
  const owner = typeof el.closest === "function" ? el.closest("[data-composition-id]") : null;
  return owner === null || owner === root;
}

function humanizeId(id) {
  return String(id || "")
    .replace(/-copy-\d+$/i, "")
    .replace(/^scene-\d+-([a-z]+)-\d+$/i, "$1")
    .replace(/[-_]+/g, " ")
    .trim() || String(id || "");
}

function parseFiniteNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseZIndex(styleAttr) {
  if (!styleAttr) return null;
  const m = styleAttr.match(/(^|;)\s*z-index\s*:\s*(-?\d+)/i);
  if (!m) return null;
  const n = parseInt(m[2], 10);
  return Number.isFinite(n) ? n : null;
}

function isHiddenElement(el, styleAttr) {
  try {
    if (el.hasAttribute("hidden")) return true;
  } catch { /* linkedom sem hasAttribute? segue */ }
  const dataHidden = (el.getAttribute("data-hidden") || "").trim().toLowerCase();
  if (dataHidden === "true" || dataHidden === "1" || dataHidden === "hidden") return true;
  if (!styleAttr) return false;
  if (/(^|;)\s*display\s*:\s*none/i.test(styleAttr)) return true;
  if (/(^|;)\s*visibility\s*:\s*hidden/i.test(styleAttr)) return true;
  return false;
}

function isLockedElement(el) {
  const v = (el.getAttribute("data-locked") || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "locked";
}

/**
 * Identidade canónica do asset SEM query/fragment (URLs assinadas nunca são
 * identidade). Devolve { ref, provenance, hasSignedUrl }.
 */
function canonicalAssetRef(raw) {
  if (!raw) return { ref: null, provenance: "none", hasSignedUrl: false };
  const s = String(raw).trim();
  if (!s) return { ref: null, provenance: "none", hasSignedUrl: false };
  const qIndex = s.indexOf("?");
  const hIndex = s.indexOf("#");
  const cut = qIndex >= 0 ? qIndex : hIndex >= 0 ? hIndex : -1;
  const hasQuery = qIndex >= 0 || hIndex >= 0;
  const lower = s.toLowerCase();
  const signedHints = ["signature=", "expires=", "x-amz-", "se=", "sig=", "token=", "sas", "signed"];
  const hasSignedUrl = hasQuery && signedHints.some((h) => lower.includes(h));
  const ref = cut >= 0 ? s.slice(0, cut) : s;
  if (!ref) return { ref: null, provenance: "none", hasSignedUrl };
  if (/^(assets\/|projects\/|compositions\/)/i.test(ref)) return { ref, provenance: hasSignedUrl ? "signed-url-redacted" : "relative", hasSignedUrl };
  if (/^https?:\/\//i.test(ref)) return { ref, provenance: hasSignedUrl ? "signed-url-redacted" : "remote", hasSignedUrl };
  return { ref, provenance: hasSignedUrl ? "signed-url-redacted" : "relative", hasSignedUrl };
}

/**
 * Derive the element registry from a composition HTML string (F05 v2).
 *
 * @param {string} html Persisted/staged composition HTML.
 * @param {{ revision?: number, compositionId?: string }} [opts]
 * @returns {{ version: number, compositionId: string, revision: number|null,
 *            elements: Array<object>, conflicts: Array<object> }}
 */
export function deriveElements(html, opts = {}) {
  const { document } = parseHTML(html);
  const root = document.querySelector("[data-composition-id]");
  const compositionId =
    (root && root.getAttribute("data-composition-id")) || opts.compositionId || "main";
  const revision = Number.isInteger(opts.revision) && opts.revision >= 0 ? opts.revision : null;
  const seen = new Map();
  const conflicts = [];
  const elements = [];
  const parentCounts = new Map();
  let order = 0;
  for (const el of document.querySelectorAll("[id],[data-hf-id]")) {
    const id = effectiveId(el);
    if (!id) continue;
    if (seen.has(id)) {
      conflicts.push({ id, firstIndex: seen.get(id), duplicateIndex: order });
      order += 1;
      continue;
    }
    seen.set(id, order);
    if (el === root) { order += 1; continue; } // a própria composição não é conteúdo
    if (id.startsWith("__vp")) { order += 1; continue; } // blocos materializados/artefactos
    if (isRootOwnedSceneClip(el, root)) { order += 1; continue; } // cenas são da timeline

    const { type, provenance } = inferTypeV2(el);
    const sceneId = nearestSceneId(el);
    const parentId = nearestParentId(el);
    const parentKey = parentId || "__root__";
    const orderInParent = parentCounts.get(parentKey) ?? 0;
    parentCounts.set(parentKey, orderInParent + 1);
    const styleAttr = el.getAttribute("style");
    const hidden = isHiddenElement(el, styleAttr);
    const locked = isLockedElement(el);
    const z = parseZIndex(styleAttr);
    const scope = sceneId ? "scene" : (type === "audio" ? "composition" : "free");
    const role = (el.getAttribute("data-role") || "").trim()
      || (type === "audio" && sceneId === null ? "composition-audio" : type);

    const entry = {
      id,
      type,
      typeProvenance: provenance,
      compositionId,
      sceneId,
      parentId,
      order,
      orderInParent,
      scope,
      role,
      hidden,
      locked,
    };
    if (z !== null) entry.z = z;

    const labelAttr = (el.getAttribute("data-label") || el.getAttribute("aria-label") || "").trim();
    if (labelAttr) entry.label = labelAttr;
    else if (type === "text") {
      const text = (el.textContent || "").trim();
      entry.label = text ? text.slice(0, 60) : humanizeId(id);
    } else {
      entry.label = humanizeId(id);
    }

    if (type === "text") {
      const text = (el.textContent || "").trim();
      if (text) entry.text = text;
    }

    const src = el.getAttribute("src");
    const bgUrl = backgroundImageUrl(styleAttr);
    const assetUrl = src || bgUrl;
    if (assetUrl) entry.srcAssetUrl = assetUrl;
    const canon = canonicalAssetRef(assetUrl);
    if (canon.ref) entry.assetRef = canon.ref;
    entry.assetProvenance = canon.provenance;
    entry.hasSignedUrl = canon.hasSignedUrl;

    const animIn = (el.getAttribute("data-anim-in") || "").trim();
    const animOut = (el.getAttribute("data-anim-out") || "").trim();
    if (animIn && animIn.toLowerCase() !== "none") entry.animIn = animIn;
    if (animOut && animOut.toLowerCase() !== "none") entry.animOut = animOut;

    // V5-P8B §2.2: keyframes (opcional, só quando há data-kf válido).
    try {
      const rawKf = el.getAttribute("data-kf");
      if (rawKf) {
        const arr = JSON.parse(rawKf);
        if (Array.isArray(arr) && arr.length > 0) entry.keyframes = arr;
      }
    } catch {
      /* data-kf malformado → ignorar, o applier deriva limpo */
    }

    const bbox = bboxAtSceneStart(styleAttr);
    if (bbox) {
      entry.bboxAtSceneStart = bbox;
      entry.bboxSource = "authored-best-effort";
    } else {
      entry.bboxSource = "unmeasured";
    }

    const start = parseFiniteNumber(el.getAttribute("data-start"));
    const duration = parseFiniteNumber(el.getAttribute("data-duration"));
    // E04: `data-media-start` é o trim point consumido pelo runtime 0.7.109;
    // o legado `data-media-offset` fica como fallback de leitura (N-1).
    const mediaStart = parseFiniteNumber(el.getAttribute("data-media-start"));
    const legacyMediaOffset = parseFiniteNumber(el.getAttribute("data-media-offset"));
    const mediaOffset = mediaStart !== null ? mediaStart : legacyMediaOffset;
    if (start !== null) entry.start = start;
    if (duration !== null) entry.duration = duration;
    if (mediaOffset !== null) entry.mediaOffset = mediaOffset;

    entry.capabilities = {
      renamable: true,
      reorderable: true,
      hideable: true,
      lockable: true,
      duplicable: true,
      removable: true,
      editableAsText: type === "text",
    };

    if (revision !== null) entry.revision = revision;

    elements.push(entry);
    order += 1;
  }
  return { version: ELEMENTS_VERSION, compositionId, revision, elements, conflicts };
}

/** True quando o envelope é registry v1 (leitura legacy preservada). */
export function isV1Registry(reg) {
  return Boolean(reg && reg.version === 1 && Array.isArray(reg.elements));
}

/** True quando o envelope é registry v2 (F05). */
export function isV2Registry(reg) {
  return Boolean(reg && reg.version === 2 && Array.isArray(reg.elements));
}

/**
 * Adapta um registry v1 para v2 com defaults explícitos (proveniência
 * "v1-adapter"). Nunca inventa revision: usa opts.revision ou null.
 */
export function adaptV1RegistryToV2(v1, opts = {}) {
  const compositionId = opts.compositionId || v1.compositionId || "main";
  const revision = Number.isInteger(opts.revision) ? opts.revision
    : (Number.isInteger(v1.revision) ? v1.revision : null);
  const parentCounts = new Map();
  const elements = (v1.elements || []).map((e, idx) => {
    const parentId = e.parentId ?? null;
    const parentKey = parentId || "__root__";
    const orderInParent = parentCounts.get(parentKey) ?? 0;
    parentCounts.set(parentKey, orderInParent + 1);
    const type = e.type || "text";
    const canon = canonicalAssetRef(e.srcAssetUrl || e.assetRef || null);
    return {
      id: e.id,
      type,
      typeProvenance: "v1-adapter",
      compositionId,
      sceneId: e.sceneId ?? null,
      parentId,
      order: Number.isInteger(e.order) ? e.order : idx,
      orderInParent,
      scope: (e.sceneId ?? null) ? "scene" : (type === "audio" ? "composition" : "free"),
      role: e.role || ((type === "audio" && (e.sceneId ?? null) === null) ? "composition-audio" : type),
      label: e.label || humanizeId(e.id),
      hidden: e.hidden ?? false,
      locked: e.locked ?? false,
      ...(e.z !== undefined && e.z !== null ? { z: e.z } : {}),
      ...(e.text ? { text: e.text } : {}),
      ...(e.srcAssetUrl ? { srcAssetUrl: e.srcAssetUrl } : {}),
      ...(canon.ref ? { assetRef: canon.ref } : {}),
      assetProvenance: e.assetProvenance || canon.provenance,
      hasSignedUrl: e.hasSignedUrl ?? canon.hasSignedUrl,
      ...(e.animIn ? { animIn: e.animIn } : {}),
      ...(e.animOut ? { animOut: e.animOut } : {}),
      ...(e.keyframes ? { keyframes: e.keyframes } : {}),
      ...(e.bboxAtSceneStart ? { bboxAtSceneStart: e.bboxAtSceneStart } : {}),
      bboxSource: e.bboxSource || (e.bboxAtSceneStart ? "authored-best-effort" : "unmeasured"),
      ...(e.start !== undefined ? { start: e.start } : {}),
      ...(e.duration !== undefined ? { duration: e.duration } : {}),
      ...(e.mediaOffset !== undefined ? { mediaOffset: e.mediaOffset } : {}),
      capabilities: e.capabilities || {
        renamable: true,
        reorderable: true,
        hideable: true,
        lockable: true,
        duplicable: true,
        removable: true,
        editableAsText: type === "text",
      },
      ...(revision !== null ? { revision } : {}),
    };
  });
  return { version: 2, compositionId, revision, elements, conflicts: [], adaptedFrom: 1 };
}

/** Normaliza v1 ou v2 para v2; lança em envelope inválido. */
export function normalizeRegistry(reg, opts = {}) {
  if (isV2Registry(reg)) return reg;
  if (isV1Registry(reg)) return adaptV1RegistryToV2(reg, opts);
  throw new Error("normalizeRegistry: envelope de registry inválido (esperado v1 ou v2)");
}

/**
 * Upsert the derived registry into storage (fire-and-forget, espelho exato
 * das guardas de persistCompositionArtifact).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient | null} supabase
 * @param {string} projectId
 * @param {{ version: number, elements: unknown[] }} registry
 * @param {(msg: string) => void} [log]
 * @param {(message: string) => void} [onFailure]
 * @returns {Promise<boolean>} true quando o upload foi confirmado.
 */
export async function persistElementsArtifact(supabase, projectId, registry, log = () => {}, onFailure = () => {}) {
  if (!supabase) return false;
  if (!projectId || !UUID_RE.test(projectId)) {
    log(`[elements-registry] skip non-orchestrator project id (${projectId})`);
    return false;
  }
  if (!registry || !Array.isArray(registry.elements)) {
    log("[elements-registry] skip invalid registry payload");
    return false;
  }
  try {
    const { error } = await supabase.storage
      .from(ARTIFACTS_BUCKET)
      .upload(elementsStoragePath(projectId), JSON.stringify(registry), {
        contentType: "application/json",
        upsert: true,
      });
    if (error) {
      log(`[elements-registry] upload failed for ${projectId}: ${error.message}`);
      onFailure(error.message);
      return false;
    }
    log(`[elements-registry] persisted compositions/elements.json (${registry.elements.length} element(s)) for ${projectId}`);
    return true;
  } catch (err) {
    const message = err?.message ?? String(err);
    log(`[elements-registry] unexpected failure for ${projectId}: ${message}`);
    onFailure(message);
    return false;
  }
}
