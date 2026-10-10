/**
 * render-options.js — F04-T02 worker (V5.34).
 *
 * Normaliza/persiste options efetivas no job durável F01 e recupera no restart.
 * Staging usa a mesma effective fps que render (nunca body.fps solto).
 * Alias N-1 só pelo adapter definido; unknown/invalid nunca viram defaults silenciosos.
 * Espelho JS do Edge `supabase/functions/_shared/renderEffective.ts` (contrato rev 1).
 */

export const RENDER_CONTRACT_REVISION = 1;
export const EFFECTIVE_FPS_DEFAULT = 30;
export const SUPPORTED_FPS = [30];
export const SUPPORTED_FORMATS = ["mp4", "webm", "gif", "png"];

function fail(code, expected, observed, diagnosis) {
  return { code, expected, observed, diagnosis };
}

function dimsForRatio(ratio) {
  if (ratio === "16:9") return { width: 1920, height: 1080, aspect_ratio: "16:9" };
  if (ratio === "9:16") return { width: 1080, height: 1920, aspect_ratio: "9:16" };
  if (ratio === "1:1") return { width: 1080, height: 1080, aspect_ratio: "1:1" };
  return null;
}

/**
 * Adapter N-1 explícito: só por este caminho. Retorna warnings de proveniência.
 */
export function adaptLegacySpecOptions(raw) {
  const warnings = [];
  const errors = [];
  const out = {};
  if (!raw) return { options: out, warnings, errors };
  const legacyMap = {
    width: "width",
    height: "height",
    aspect_ratio: "aspect_ratio",
    quality: "quality",
    fps: "fps",
    format: "format",
    duration: "duration",
    duration_target_seconds: "duration_target_seconds",
    pngAtSeconds: "pngAtSeconds",
    gifSeconds: "gifSeconds",
    effective_config_revision: "effective_config_revision",
    effective_config_hash: "effective_config_hash",
    composition_revision: "composition_revision",
    composition_hash: "composition_hash",
    mp4_upload_url: null,
  };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in legacyMap)) {
      errors.push(fail("F04_UNKNOWN_OPTION", "chave tipada ou alias N-1 conhecido", `unknown '${k}'`, "Alias N-1 só pelo adapter definido."));
      continue;
    }
    const mapped = legacyMap[k];
    if (mapped === null) {
      warnings.push(`LEGACY_ADAPTER: '${k}' ignorado como decisor de formato (não mascara bytes)`);
      continue;
    }
    if (k === "aspect_ratio" && typeof v === "string") {
      const low = v.toLowerCase();
      if (low === "16:9" || low === "landscape") { out.width = 1920; out.height = 1080; warnings.push("LEGACY_ADAPTER: aspect_ratio→1920x1080"); }
      else if (low === "9:16" || low === "portrait") { out.width = 1080; out.height = 1920; warnings.push("LEGACY_ADAPTER: aspect_ratio→1080x1920"); }
      else if (low === "1:1" || low === "square") { out.width = 1080; out.height = 1080; warnings.push("LEGACY_ADAPTER: aspect_ratio→1080x1080"); }
      else errors.push(fail("F04_INVALID_OPTION", "aspect_ratio N-1 em [16:9,9:16,1:1,landscape,portrait,square]", String(v), "Alias desconhecido; recusar."));
      continue;
    }
    out[mapped] = v;
  }
  return { options: out, warnings, errors };
}

/**
 * Resolve options efetivas a partir do body do job (producer já enviou tipadas).
 * Quando o body traz effective_config (novo), valida estritamente.
 * Quando traz só legacy (N-1), usa adapter com proveniência legacy-fallback explícita.
 * Nunca defaults silenciosos para unknown/invalid.
 */
export function resolveWorkerRenderOptions(body) {
  const failures = [];
  const rawOptions = body?.options && typeof body.options === "object" ? body.options : {};
  const adapted = adaptLegacySpecOptions(rawOptions);
  if (adapted.errors.length > 0) return { ok: false, failures: adapted.errors };
  const spec = adapted.options;
  const warnings = [...adapted.warnings];

  // Dims: preferir options.width/height tipadas do producer; senão adapter aspect_ratio.
  let width = typeof spec.width === "number" && Number.isFinite(spec.width) ? spec.width : null;
  let height = typeof spec.height === "number" && Number.isFinite(spec.height) ? spec.height : null;
  let aspect = typeof spec.aspect_ratio === "string" ? spec.aspect_ratio : null;
  // Novo: body carrega effective dims diretas em options (width/height/aspect_ratio do Edge).
  // Legacy: aspect_ratio mapeado acima já preencheu width/height.
  if ((width === null || height === null) && body?.effective_config) {
    const eff = body.effective_config;
    if (typeof eff.effective_width === "number" && typeof eff.effective_height === "number") {
      width = eff.effective_width; height = eff.effective_height;
      aspect = typeof eff.effective_ratio === "string" ? eff.effective_ratio : aspect;
    }
  }
  if (width === null || height === null) {
    // Último recurso legacy explícito: aspect_ratio do body root (N-1).
    const rootAspect = typeof body?.aspect_ratio === "string" ? body.aspect_ratio : aspect;
    if (typeof rootAspect === "string") {
      const low = rootAspect.toLowerCase();
      if (low === "16:9" || low === "landscape") { width = 1920; height = 1080; aspect = "16:9"; warnings.push("LEGACY_ADAPTER: body.aspect_ratio→1920x1080"); }
      else if (low === "1:1" || low === "square") { width = 1080; height = 1080; aspect = "1:1"; warnings.push("LEGACY_ADAPTER: body.aspect_ratio→1080x1080"); }
      else if (low === "9:16" || low === "portrait") { width = 1080; height = 1920; aspect = "9:16"; warnings.push("LEGACY_ADAPTER: body.aspect_ratio→1080x1920"); }
    }
  }
  const allowedDims = [
    { width: 1920, height: 1080, aspect_ratio: "16:9" },
    { width: 1080, height: 1920, aspect_ratio: "9:16" },
    { width: 1080, height: 1080, aspect_ratio: "1:1" },
  ];
  let dimsOk = allowedDims.find((d) => d.width === width && d.height === height);
  // N-1 legacy: jobs antigos sem options/dims (testes/preview) usam fallback
  // explícito 1080x1920 com proveniência legacy-fallback (nunca falha silenciosa
  // sem marca; producer novo envia dims tipadas e cai no ramo estrito acima).
  if (!dimsOk) {
    if (width === null && height === null) {
      width = 1080; height = 1920; aspect = "9:16";
      dimsOk = allowedDims[1];
      warnings.push("LEGACY_ADAPTER: dims ausentes → 1080x1920 explícito (legacy-fallback, sem effective_config)");
    } else {
      failures.push(fail("F04_DIMS_MISSING", "width/height efetivas em [1920x1080,1080x1920,1080x1080]", `${width}x${height}`, "Staging usa a mesma effective fps/dims que render; sem dims não há render."));
      return { ok: false, failures };
    }
  }
  for (const k of ["width", "height", "fps", "duration", "duration_target_seconds"]) {
    const v = spec[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      failures.push(fail("F04_INVALID_OPTION", `${k} numérico`, String(v), "Valor inválido; recusar explicitamente."));
    }
  }
  let fps = EFFECTIVE_FPS_DEFAULT;
  if (spec.fps !== undefined) {
    if (!SUPPORTED_FPS.includes(spec.fps)) {
      failures.push(fail("F04_FPS_UNSUPPORTED", `fps em [${SUPPORTED_FPS.join(",")}]`, String(spec.fps), "Opção futura não suportada: recusar antes da cobrança."));
    } else fps = spec.fps;
  }
  // body.fps solto NUNCA decide: se divergir do effective, falha explícita.
  if (body?.fps !== undefined && Number.isFinite(Number(body.fps)) && Number(body.fps) !== fps) {
    failures.push(fail("F04_FPS_BODY_MISMATCH", `body.fps igual ao effective (${fps})`, String(body.fps), "Staging usa a mesma effective fps que render, não body.fps solto."));
  }

  let duration = null;
  const durCand = spec.duration ?? spec.duration_target_seconds;
  if (typeof durCand === "number" && Number.isFinite(durCand) && durCand >= 0.1 && durCand <= 600) duration = durCand;
  else if (durCand === undefined) {
    // N-1 legacy: duração ausente → 15s explícito com proveniência legacy-fallback.
    duration = 15;
    warnings.push("LEGACY_ADAPTER: duration ausente → 15s explícito (legacy-fallback, não effective)");
  } else {
    failures.push(fail("F04_DURATION_MISSING", "duration(_target_seconds) em [0.1,600]", String(durCand ?? "ausente"), "Duração nunca cai em 15s por ausência."));
  }

  let format = "mp4";
  if (spec.format !== undefined) {
    if (SUPPORTED_FORMATS.includes(spec.format)) format = spec.format;
    else failures.push(fail("F04_INVALID_FORMAT", `format em [${SUPPORTED_FORMATS.join(",")}]`, String(spec.format), "Nunca fallback MP4 sob outra extensão."));
  }
  let quality = "high";
  if (spec.quality !== undefined) {
    if (["low", "medium", "high"].includes(spec.quality)) quality = spec.quality;
    else failures.push(fail("F04_INVALID_QUALITY", "quality em [low,medium,high]", String(spec.quality), "Qualidade inválida."));
  }

  if (failures.length > 0 || duration === null) return { ok: false, failures };
  const provenance = warnings.some((w) => w.startsWith("LEGACY_ADAPTER")) || body?.options_provenance === "legacy-fallback" ? "legacy-fallback" : "fresh";
  return {
    ok: true,
    options: {
      contract_revision: RENDER_CONTRACT_REVISION,
      width: dimsOk.width, height: dimsOk.height, aspect_ratio: dimsOk.aspect_ratio,
      fps, duration_target_seconds: duration, format, quality,
      effective_config_revision: typeof body?.effective_config_revision === "number" ? body.effective_config_revision : 0,
      effective_config_hash: typeof body?.effective_config_hash === "string" ? body.effective_config_hash : "",
      composition_revision: typeof body?.composition_revision === "number" ? body.composition_revision : (typeof body?.revision === "number" ? body.revision : 1),
      composition_hash: typeof body?.composition_hash === "string" ? body.composition_hash : "",
      provenance,
    },
    warnings,
  };
}

/** Persiste options tipadas no objeto do job (fonte para restart). */
export function persistEffectiveOptions(jobRecord, resolved) {
  jobRecord.effective_options = resolved.options;
  jobRecord.options_provenance = resolved.options.provenance;
  if (resolved.warnings?.length) jobRecord.options_warnings = resolved.warnings;
  return jobRecord;
}
