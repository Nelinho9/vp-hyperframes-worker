/**
 * render-argv.js — F04-T06 worker (V5.34).
 *
 * Builder de argv não-shell para lint/check/snapshot/render/ffprobe.
 * mp4/webm/gif/png só com capacidades provadas na CLI 0.7.109.
 * Nunca `snapshot --describe` por provider (sempre --describe false).
 * --fps NÃO emitido (não provado no help/fixtures da 0.7.109); fps provado
 * por dims gate + window normalization.
 */

export const SUPPORTED_FORMATS = ["mp4", "webm", "gif", "png"];
export const SUPPORTED_FPS = [30];

export function mimeForFormat(format) {
  if (format === "mp4") return "video/mp4";
  if (format === "webm") return "video/webm";
  if (format === "gif") return "image/gif";
  return "image/png";
}

export function outputNameForFormat(format) {
  if (format === "png") return "frame.png";
  return `output.${format}`;
}

function baseFor(cmd, args) {
  const bin = process.env.HYPERFRAMES_BIN || "";
  if (bin) return { command: bin, args: [cmd, ...args] };
  return { command: "npx", args: ["hyperframes", cmd, ...args] };
}

/**
 * @param {{ format: string, jobDir: string, fps?: number, pngAtSeconds?: unknown, gifSeconds?: unknown, durationTargetSeconds?: number }} input
 */
export function buildExportArgv(input) {
  const fmt = input.format;
  if (!SUPPORTED_FORMATS.includes(fmt)) {
    return { ok: false, code: "F04_UNSUPPORTED_FORMAT", expected: `format em [${SUPPORTED_FORMATS.join(",")}]`, observed: String(fmt), diagnosis: "Unsupported fica claro e sem falso sucesso." };
  }
  if (input.fps !== undefined && !SUPPORTED_FPS.includes(input.fps)) {
    return { ok: false, code: "F04_FPS_UNSUPPORTED", expected: `fps em [${SUPPORTED_FPS.join(",")}]`, observed: String(input.fps), diagnosis: "Validar --fps com ajuda/fixtures da 0.7.109 antes de usar." };
  }
  const notes = [
    "CLI pinada 0.7.109; sem upgrade/refresh/latest implícito.",
    "--fps omitido (não provado na 0.7.109); fps efetivo provado por dims gate + staging normalization.",
    "Nunca snapshot --describe por provider; sempre --describe false.",
  ];
  if (fmt === "png") {
    const at = typeof input.pngAtSeconds === "number" && Number.isFinite(input.pngAtSeconds) ? input.pngAtSeconds : 1.5;
    const dur = typeof input.durationTargetSeconds === "number" ? input.durationTargetSeconds : 60;
    if (!(at >= 0) || !(at < dur)) {
      return { ok: false, code: "F04_PNG_TIMESTAMP_INVALID", expected: `pngAt em [0,${dur})`, observed: String(input.pngAtSeconds), diagnosis: "PNG usa timestamp válido e MIME image/png." };
    }
    const out = `${input.jobDir}/renders/${outputNameForFormat(fmt)}`;
    const b = baseFor("snapshot", ["--at", String(at), "--no-end", "--describe", "false", "-o", out, input.jobDir]);
    return { ok: true, ...b, outputName: outputNameForFormat(fmt), mime: mimeForFormat(fmt), deadlineMs: 120_000, notes };
  }
  if (fmt === "gif") {
    const gifSec = typeof input.gifSeconds === "number" && Number.isFinite(input.gifSeconds) ? input.gifSeconds : 8;
    if (!(gifSec > 0) || !(gifSec <= 60)) {
      return { ok: false, code: "F04_GIF_DURATION_INVALID", expected: "gifSeconds em (0,60]", observed: String(input.gifSeconds), diagnosis: "GIF aplica target duration com formato explícito, deadline e erro visível." };
    }
    const out = `${input.jobDir}/renders/${outputNameForFormat(fmt)}`;
    const b = baseFor("render", ["--quality", "high", "--workers", "1", "--format", "gif", "-o", out, input.jobDir]);
    return { ok: true, ...b, outputName: outputNameForFormat(fmt), mime: mimeForFormat(fmt), deadlineMs: 600_000, notes: [...notes, `GIF trim explícito -t ${gifSec}s via ffmpeg com erro visível (sem catch vazio).`] };
  }
  const out = `${input.jobDir}/renders/${outputNameForFormat(fmt)}`;
  const fmtArgs = fmt === "mp4" ? [] : ["--format", fmt];
  const b = baseFor("render", ["--quality", "high", "--workers", "1", ...fmtArgs, "-o", out, input.jobDir]);
  return { ok: true, ...b, outputName: outputNameForFormat(fmt), mime: mimeForFormat(fmt), deadlineMs: 600_000, notes };
}

export function buildLintArgv(jobDir) {
  return baseFor("lint", ["--json", jobDir]);
}

export function buildCheckArgv(jobDir) {
  return baseFor("check", [jobDir]);
}

export function buildFfprobeArgv(file) {
  return { command: "ffprobe", args: ["-v", "error", "-show_format", "-show_streams", "-of", "json", file] };
}

export function buildRenderSnapshotArgsForCoverage(times, projectDir) {
  const bin = process.env.HYPERFRAMES_BIN || "";
  const base = bin ? [bin, ["snapshot"]] : ["npx", ["hyperframes", "snapshot"]];
  const args = [...base[1], "--at", times.map((t) => String(Math.round(t * 1000) / 1000)).join(","), "--no-end", "--describe", "false", projectDir];
  return { command: base[0], args };
}
