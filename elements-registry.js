/**
 * elements-registry — V5-P3A (§8.1, AD-5): inventário de elementos da
 * composição (`elements.json`) derivado retroativamente do index.html staged.
 *
 * É a cola editor↔assets↔chat↔quality: S16 serve GET /elements a partir
 * deste artefacto, S17 lista assets usados, P4 consome-o nas tools do chat e
 * P6 alimenta o quality gate. Publicado EM CADA PERSIST (staging pelo próprio
 * worker; /patch e /restructure cavalgam a resposta e o caller persiste —
 * mesmas regras do HTML em V4-04C).
 *
 * Contrato (docs/video-engine/V5_P3A_ELEMENTS_REGISTRY.md §2):
 *   { version: 1, elements: [{ id, type, sceneId, text?, srcAssetUrl?,
 *                              animIn?, animOut?, bboxAtSceneStart? }] }
 * Campos opcionais são OMITIDOS quando não se aplicam ("não lido do DOM" ≠
 * valor neutro); ordem de documento; dedup de id (primeira ocorrência ganha).
 *
 * Derivação SEM layout: linkedom não mede caixas — `bboxAtSceneStart` é
 * best-effort a partir do estilo inline (authored px + deltas `--el-*`
 * escritos pela geometria V5-P0B).
 */

import { parseHTML } from "linkedom";

export const ELEMENTS_VERSION = 1;

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

/** Type inference per spec §2.2 (estável → prefixo → tag → svg → background → text). */
function inferType(el) {
  const id = effectiveId(el);
  const stable = stableIdType(id);
  if (stable) return stable;
  const prefix = (id.split("-")[0] || "").toLowerCase();
  for (const [re, type] of PREFIX_TYPES) {
    if (re.test(prefix)) return type;
  }
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "img") return "image";
  if (tag === "video") return "video";
  if (tag === "audio") return "audio";
  if (hasSvgAncestor(el)) return "shape";
  if (backgroundImageUrl(el.getAttribute("style"))) return "image";
  return "text"; // mesmo fallback do editor (inferElementType)
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
  if (Number.isFinite(left) || Number.isFinite(dx)) bbox.x = (left || 0) + (dx || 0);
  if (Number.isFinite(top) || Number.isFinite(dy)) bbox.y = (top || 0) + (dy || 0);
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

/**
 * Derive the element registry from a composition HTML string.
 *
 * @param {string} html Persisted/staged composition HTML.
 * @returns {{ version: number, elements: Array<object> }}
 */
export function deriveElements(html) {
  const { document } = parseHTML(html);
  const root = document.querySelector("[data-composition-id]");
  const seen = new Set();
  const elements = [];
  for (const el of document.querySelectorAll("[id],[data-hf-id]")) {
    const id = effectiveId(el);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (el === root) continue; // a própria composição não é conteúdo
    if (id.startsWith("__vp")) continue; // blocos materializados/artefactos
    if (isRootOwnedSceneClip(el, root)) continue; // cenas são da timeline

    const entry = {
      id,
      type: inferType(el),
      sceneId: nearestSceneId(el),
    };
    const styleAttr = el.getAttribute("style");

    if (entry.type === "text") {
      const text = (el.textContent || "").trim();
      if (text) entry.text = text;
    }

    const src = el.getAttribute("src");
    const bgUrl = backgroundImageUrl(styleAttr);
    const assetUrl = src || bgUrl;
    if (assetUrl) entry.srcAssetUrl = assetUrl;

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
    if (bbox) entry.bboxAtSceneStart = bbox;

    elements.push(entry);
  }
  return { version: ELEMENTS_VERSION, elements };
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
