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
    if (s.measuredSec === null || !Number.isFinite(s.measuredSec)) {
      failures.push({ code: "F04_VO_UNMEASURED", expected: "measured_duration real (WAV/MP3 medido)", observed: `slot ${s.frameNumber}: não medido`, diagnosis: "Sem word estimates como acústica." });
      continue;
    }
    if (s.measurementSource && /estimate|wpm|word/i.test(s.measurementSource)) {
      failures.push({ code: "F04_VO_ESTIMATED", expected: "measured (acoustic), nunca estimated", observed: `slot ${s.frameNumber}: ${s.measurementSource}`, diagnosis: "Não usar word estimates como acústica." });
      continue;
    }
    const slot = s.windowEnd - s.windowStart;
    if (s.measuredSec > slot + 0.25) {
      failures.push({
        code: "F04_VO_WINDOW_OVERFLOW",
        expected: `voz <= slot ${slot}s (+0,25s tol)`,
        observed: `slot ${s.frameNumber}: voz ${s.measuredSec}s em janela ${slot}s`,
        diagnosis: "Fixture 5.92s/3s exige resolução F03 ou falha explícita; nunca truncar VO silenciosamente.",
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
