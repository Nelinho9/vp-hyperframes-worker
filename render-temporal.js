/**
 * render-temporal.js — F04-T05 worker (V5.34).
 *
 * Valida composition root/windows e audio plan F03 antes do render.
 * Compara source durations reais vs slots sem truncar VO.
 * Não usa word estimates como acústica. Respeita overlaps aprovados.
 * Duração por max(start+duration)/root, não soma indiscriminada.
 */

export const EFFECTIVE_FPS_DEFAULT = 30;

/**
 * §4: só uma medida CONFIÁVEL promove timing. Espelha `decideVoiceFit`
 * (`secondsTrusted`, `audioMeasure.ts`): `null` (legado sem classificação),
 * `measured-wav` ou `measured-mp3`. `estimated-*`, `unknown` e qualquer
 * classificação não medida (wpm/word estimate) recusam. Antes desta correção
 * (N-J) um regex `/estimate|wpm|word/i` deixava passar `unknown` — que a
 * decisão única recusa — e o produtor do plano passou a poder transportá-lo.
 */
export const TRUSTED_MEASUREMENT_SOURCES = ["measured-wav", "measured-mp3"];

export function measurementSourceTrusted(source) {
  return source === null || source === undefined || TRUSTED_MEASUREMENT_SOURCES.includes(source);
}

/**
 * Mesma quantização de `decideVoiceFit`/`windowFramesFrom` (§4): `floor(s*fps+0,5)`,
 * recusando entrada não finita/negativa ou fora do intervalo seguro.
 */
export function secondsToFrameFloorHalfUp(seconds, fps = EFFECTIVE_FPS_DEFAULT) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const scaled = seconds * fps + 0.5;
  if (!Number.isFinite(scaled) || scaled >= Number.MAX_SAFE_INTEGER) return null;
  return Math.floor(scaled);
}

/**
 * @param {{ rootDuration: number|null, windows: Array<{id:string,start:number,duration:number}>, audioSlots?: Array<{frameNumber:number,measuredSec:number|null,measurementSource?:string|null,windowStart:number,windowEnd:number}>, transitionsMs?: number[], fps?: number }} args
 */
export function validateTemporalAudioPlan(args) {
  const failures = [];
  const fps = args.fps ?? EFFECTIVE_FPS_DEFAULT;
  const windows = Array.isArray(args.windows) ? args.windows : [];
  if (windows.length === 0) {
    return { ok: false, failures: [{ code: "F04_NO_WINDOWS", expected: ">=1 root window", observed: "0", diagnosis: "Validar composition root/windows antes do render." }], totalSec: 0 };
  }
  let total = 0;
  let prevEnd = 0;
  windows.forEach((w, i) => {
    if (!(w.duration > 0)) failures.push({ code: "F04_WINDOW_INVALID", expected: "duration > 0", observed: `${w.id}:${w.duration}`, diagnosis: `Janela ${i + 1} inválida.` });
    if (w.start < prevEnd - 0.001) failures.push({ code: "F04_WINDOW_OVERLAP", expected: `start >= ${prevEnd}`, observed: `${w.id}:${w.start}`, diagnosis: "Respeitar overlap de transições aprovado e media offsets." });
    prevEnd = Math.max(prevEnd, w.start + w.duration);
    total = Math.max(total, w.start + w.duration);
  });
  total = Math.round(total * 100) / 100;
  if (typeof args.rootDuration === "number" && Number.isFinite(args.rootDuration)) {
    const tol = 1 / Math.max(1, fps) + 0.02;
    if (Math.abs(total - args.rootDuration) > Math.max(tol, 0.25)) {
      failures.push({ code: "F04_ROOT_MISMATCH", expected: `root ${args.rootDuration}s`, observed: `${total}s (max, não soma)`, diagnosis: "Testar duração com max(start+duration)/root, não soma indiscriminada." });
    }
  }
  for (const t of args.transitionsMs ?? []) {
    if (!(t >= 0) || !(t <= 2000)) failures.push({ code: "F04_TRANSITION_BOUNDS", expected: "transição em [0,2000]ms", observed: String(t), diagnosis: "Transições/overlaps aprovados respeitados." });
  }
  for (const s of args.audioSlots ?? []) {
    let exactFrames = null;
    const hasSamples = s.sampleCount != null || s.sampleRate != null;
    if (s.decodeComplete === false || (hasSamples && (s.decodeComplete !== true
      || !Number.isSafeInteger(s.sampleCount) || s.sampleCount < 0
      || !Number.isSafeInteger(s.sampleRate) || s.sampleRate <= 0
      || !Number.isSafeInteger(fps) || fps <= 0))) {
      failures.push({ code: "F04_VO_UNMEASURED", expected: "complete decoded samples with a valid rate", observed: `slot ${s.frameNumber}: invalid decode/sample certificate`, diagnosis: "Partial or invalid measurement cannot certify render timing." });
      continue;
    }
    if (hasSamples) {
      const numerator = BigInt(s.sampleCount) * BigInt(fps);
      const denominator = BigInt(s.sampleRate);
      exactFrames = Number((numerator + denominator - 1n) / denominator);
      if (typeof s.measuredSec === "number" && (!Number.isFinite(s.measuredSec)
        || Math.abs(s.measuredSec - s.sampleCount / s.sampleRate) > 0.000051)) {
        failures.push({ code: "F04_VO_UNMEASURED", expected: "seconds consistent with exact samples", observed: `slot ${s.frameNumber}: inconsistent certificate`, diagnosis: "Do not combine measurements from different sources." });
        continue;
      }
    }
    if (exactFrames === null && (s.measuredSec === null || !Number.isFinite(s.measuredSec) || s.measuredSec < 0)) {
      failures.push({ code: "F04_VO_UNMEASURED", expected: "measured_duration real (WAV/MP3 medido)", observed: `slot ${s.frameNumber}: não medido`, diagnosis: "Sem word estimates como acústica." });
      continue;
    }
    if (!measurementSourceTrusted(s.measurementSource)) {
      failures.push({
        code: "F04_VO_ESTIMATED",
        expected: "medida acústica (measured-wav|measured-mp3) ou legado sem classificação — nunca estimated/unknown",
        observed: `slot ${s.frameNumber}: ${s.measurementSource}`,
        diagnosis: "Mesma regra da decisão única de fit (§4): estimated/unknown nunca promovem timing.",
      });
      continue;
    }
    // N-F/N-G (§4): MESMA decisão de fit do contrato — janela e voz quantizadas a
    // frames como `decideVoiceFit` (`windowFramesFrom` + ramo de segundos), SEM a
    // tolerância local de +0,25s, e com a mesma guarda de janela inválida. Antes
    // desta correção o gate do render aceitava uma voz até +0,25s acima da janela
    // (~7,5 frames a 30 fps) e era fail-open em janelas malformadas.
    const startFrame = secondsToFrameFloorHalfUp(s.windowStart, fps);
    const endFrame = secondsToFrameFloorHalfUp(s.windowEnd, fps);
    if (startFrame === null || endFrame === null || endFrame - startFrame <= 0) {
      failures.push({
        code: "F04_VO_WINDOW_INVALID",
        expected: "janela finita (start/end ≥ 0) e não colapsada",
        observed: `slot ${s.frameNumber}: start ${s.windowStart} end ${s.windowEnd}`,
        diagnosis: "Mesma guarda de janela inválida da decisão única de fit (§4).",
      });
      continue;
    }
    const windowFrames = endFrame - startFrame;
    const usedFrames = exactFrames ?? Math.ceil(Number((s.measuredSec * fps).toFixed(6)));
    if (usedFrames > windowFrames) {
      failures.push({
        code: "F04_VO_WINDOW_OVERFLOW",
        expected: `voz <= janela de ${windowFrames} frames`,
        observed: `slot ${s.frameNumber}: voz ${s.measuredSec}s (${usedFrames} frames) em janela ${windowFrames} frames`,
        diagnosis: "Mesma decisão de fit do contrato (§4), sem tolerância local; exige resolução F03 ou falha explícita.",
      });
    }
  }
  return failures.length === 0 ? { ok: true, totalSec: total } : { ok: false, failures, totalSec: total };
}

/** Extrai windows root de HTML (só composição root; nested ignorados pelo owner). */
export function parseRootWindows(html) {
  const windows = [];
  // Sem linkedom aqui para manter o módulo puro/testável: regex mínima para
  // clips root. O server usa thumbnails.parseSceneWindows para o caso completo.
  const re = /<div\b[^>]*class\s*=\s*["'][^"']*\bclip\b[^"']*["'][^>]*>/gi;
  let m;
  let idx = 0;
  while ((m = re.exec(html ?? "")) !== null) {
    const tag = m[0];
    if (/\bdata-composition-id\s*=/i.test(tag)) continue;
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag);
    const id = idM ? idM[1] : `clip-${++idx}`;
    if (!/^scene-\d+/i.test(id)) continue;
    const sM = /\bdata-start\s*=\s*["']([^"']+)["']/i.exec(tag);
    const dM = /\bdata-duration\s*=\s*["']([^"']+)["']/i.exec(tag);
    const start = sM ? parseFloat(sM[1]) : NaN;
    const duration = dM ? parseFloat(dM[1]) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(duration)) continue;
    windows.push({ id, start, duration });
  }
  windows.sort((a, b) => a.start - b.start);
  return windows;
}

export function parseRootDuration(html) {
  const m = /<div\b[^>]*data-composition-id\s*=[^>]*>/i.exec(html ?? "");
  if (!m) return null;
  const d = /\bdata-duration\s*=\s*["']([^"']+)["']/i.exec(m[0]);
  if (!d) return null;
  const v = parseFloat(d[1]);
  return Number.isFinite(v) ? v : null;
}
