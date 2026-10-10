/**
 * render-verify.js — F04-T07 worker (V5.34).
 *
 * Verifica bytes antes de upload/DONE: ffprobe + signature/MIME por output.
 * Divergência falha com expected/observed + diagnóstico sanitizado (sem URLs assinadas).
 */

export function mimeForFormat(format) {
  if (format === "mp4") return "video/mp4";
  if (format === "webm") return "video/webm";
  if (format === "gif") return "image/gif";
  return "image/png";
}

function parseFps(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(raw.trim());
    if (m) {
      const n = Number(m[1]); const d = Number(m[2]);
      if (d !== 0 && Number.isFinite(n) && Number.isFinite(d)) return n / d;
    }
    const f = Number(raw);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

/**
 * @param {{ ffprobeJson: { format?: { format_name?: string, duration?: string }, streams?: Array<{ codec_type?: string, codec_name?: string, width?: number, height?: number, avg_frame_rate?: string, duration?: string }> }, mime: string, fileSizeBytes: number, expected: { width: number, height: number, fps: number, duration_target_seconds: number, format: string, mode?: 'deterministic'|'narrated' } }} args
 */
export function validateFfprobeOutput(args) {
  const failures = [];
  const exp = args.expected;
  const fmt = exp.format;
  const mode = exp.mode ?? "deterministic";
  const expectedMime = mimeForFormat(fmt);
  if (args.mime !== expectedMime) {
    failures.push({ code: "F04_MIME_MISMATCH", expected: expectedMime, observed: args.mime, diagnosis: "MIME/output name coincidem com signed target e callback; não aceitar MP4 em path WebM." });
  }
  if (fmt === "png") {
    const video = args.ffprobeJson.streams?.find((s) => s.codec_type === "video") ?? null;
    if (video && (video.width !== exp.width || video.height !== exp.height)) {
      failures.push({ code: "F04_PNG_DIMS", expected: `${exp.width}x${exp.height}`, observed: `${video.width}x${video.height}`, diagnosis: "PNG com regras próprias." });
    }
    const audio = args.ffprobeJson.streams?.find((s) => s.codec_type === "audio");
    if (audio) failures.push({ code: "F04_PNG_AUDIO", expected: "sem stream áudio", observed: `audio ${audio.codec_name ?? "?"}`, diagnosis: "PNG não tem duração/FPS/stream áudio." });
    if (args.fileSizeBytes <= 0) failures.push({ code: "F04_EMPTY_FILE", expected: "size > 0", observed: String(args.fileSizeBytes), diagnosis: "Ficheiro vazio." });
    return failures.length === 0 ? { ok: true } : { ok: false, failures };
  }
  if (fmt === "gif") {
    if (args.fileSizeBytes <= 0) failures.push({ code: "F04_EMPTY_FILE", expected: "size > 0", observed: String(args.fileSizeBytes), diagnosis: "Ficheiro vazio." });
    const durRaw = args.ffprobeJson.format?.duration;
    const dur = durRaw !== undefined ? Number(durRaw) : NaN;
    if (Number.isFinite(dur) && Math.abs(dur - exp.duration_target_seconds) > Math.max(1, exp.duration_target_seconds * 0.2)) {
      failures.push({ code: "F04_GIF_DURATION", expected: `${exp.duration_target_seconds}s ±20%`, observed: `${dur}s`, diagnosis: "GIF com duration explícita." });
    }
    const audio = args.ffprobeJson.streams?.find((s) => s.codec_type === "audio");
    if (audio) failures.push({ code: "F04_GIF_AUDIO", expected: "sem promessa de áudio", observed: `audio ${audio.codec_name ?? "?"}`, diagnosis: "GIF não pode prometer áudio." });
    return failures.length === 0 ? { ok: true } : { ok: false, failures };
  }
  const formatName = args.ffprobeJson.format?.format_name ?? "";
  const wantsMp4 = fmt === "mp4" ? /mp4|mov/i.test(formatName) : /webm|matroska/i.test(formatName);
  if (!wantsMp4) {
    failures.push({ code: "F04_CONTAINER_MISMATCH", expected: fmt, observed: formatName || "(sem format_name)", diagnosis: "Container/codecs medidos por ffprobe + signature/MIME." });
  }
  const video = args.ffprobeJson.streams?.find((s) => s.codec_type === "video");
  if (!video) {
    failures.push({ code: "F04_NO_VIDEO_STREAM", expected: "1 stream vídeo", observed: "0", diagnosis: "Sem stream vídeo o output falha antes de DONE." });
  } else {
    if (video.width !== exp.width || video.height !== exp.height) {
      failures.push({ code: "F04_DIMS_MISMATCH", expected: `${exp.width}x${exp.height}`, observed: `${video.width}x${video.height}`, diagnosis: "Validar contra effective config e C3." });
    }
    const fpsObserved = parseFps(video.avg_frame_rate);
    if (fpsObserved === null || Math.abs(fpsObserved - exp.fps) > 0.5) {
      failures.push({ code: "F04_FPS_MISMATCH", expected: `${exp.fps}fps`, observed: String(video.avg_frame_rate ?? "?"), diagnosis: "FPS temporal medido." });
    }
  }
  const durRaw = args.ffprobeJson.format?.duration ?? video?.duration;
  const dur = durRaw !== undefined ? Number(durRaw) : NaN;
  if (!Number.isFinite(dur)) {
    failures.push({ code: "F04_DURATION_UNMEASURED", expected: `${exp.duration_target_seconds}s`, observed: "duração não medida", diagnosis: "Medir duração por ffprobe; sem duração não há DONE." });
  } else {
    const tol = mode === "deterministic" ? 1 / Math.max(1, exp.fps) + 0.02 : 0.25;
    if (Math.abs(dur - exp.duration_target_seconds) > tol) {
      failures.push({
        code: mode === "deterministic" ? "F04_DURATION_FRAME_TOL" : "F04_DURATION_NARRATED_TOL",
        expected: `${exp.duration_target_seconds}s ±${mode === "deterministic" ? "1 frame" : "0,25s (sem cortar fala)"}`,
        observed: `${dur}s`,
        diagnosis: mode === "deterministic" ? "±1 frame para fixtures determinísticas." : "Até ±0,25s ao alvo aprovado, sem cortar fala.",
      });
    }
  }
  if (args.fileSizeBytes <= 0) failures.push({ code: "F04_EMPTY_FILE", expected: "size > 0", observed: String(args.fileSizeBytes), diagnosis: "Ficheiro vazio." });
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/** PNG signature bytes (89 50 4E 47 0D 0A 1A 0A). */
export function isPngSignature(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

/** MP4 ftyp box nos primeiros bytes (simplificado). */
export function isMp4Signature(bytes) {
  if (!bytes || bytes.length < 12) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}
