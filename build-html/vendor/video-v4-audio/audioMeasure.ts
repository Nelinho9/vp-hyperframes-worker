/**
 * audioMeasure.ts — E02/I1: medição real de binários TTS por formato e a
 * ÚNICA decisão de fit voz↔janela (frames racionais, contrato
 * 15_E02_CONTRATOS_AUDIO_TEMPO.md §3/§4).
 *
 * WAV: header RIFF/WAVE + fmt + data → só é `measured-wav` quando o chunk
 * `data` declarado está integralmente presente, codec PCM/float, blockAlign e
 * byteRate coerentes e o tamanho é múltiplo do block; sampleCount = samples
 * PCM por canal (N). Data truncado/não coerente → null (unknown), nunca um
 * número menor silencioso.
 * MP3: structural header-chain probe only. Even a complete chain cannot
 * certify decoded Layer III payload. Always estimated-mp3/decodeComplete=false;
 * structural sample counts never promote timing without real decoding.
 *
 * Fit (resolveLongVoice/decideVoiceFit): janela em frames [F,E); ocupação
 * exacta `ceil(N × fps × rateDen / (sr × rateNum))` por inteiros/racionais,
 * SEM tolerância de +0,25s. Medida ausente/estimada → VO_DURATION_UNMEASURED.
 */
export type AudioDurationSource = "measured-wav" | "measured-mp3" | "estimated-mp3" | "unknown";

export const AUDIO_MEASURE_METHOD_WAV = "pcm-wav@2";
export const AUDIO_MEASURE_METHOD_MP3 = "mpeg-frames@2";

/** FPS suportado no mapping E02 (30/1). */
export const AUDIO_FPS = 30;

export interface MeasuredAudio {
  durationSec: number | null;
  source: AudioDurationSource;
  sampleRate?: number;
  channels?: number;
  /** N — samples PCM por canal efetivamente contados (decode completo). */
  sampleCount?: number | null;
  /** método/versão da medição (auditoria). */
  method?: string;
  /** true só quando o binário foi consumido até EOF dentro do formato. */
  decodeComplete?: boolean;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── WAV (PCM/float com decode completo) ───────────────────────────────────

interface WavFmt {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  /** formato efetivo quando WAVE_FORMAT_EXTENSIBLE (0xFFFE). */
  subFormat?: number;
}

function parseWavFmt(bytes: Uint8Array, bodyStart: number, size: number): WavFmt | null {
  if (size < 16 || bodyStart + 16 > bytes.length) return null;
  const fmt: WavFmt = {
    audioFormat: u16le(bytes, bodyStart),
    channels: u16le(bytes, bodyStart + 2),
    sampleRate: u32le(bytes, bodyStart + 4),
    byteRate: u32le(bytes, bodyStart + 8),
    blockAlign: u16le(bytes, bodyStart + 12),
    bitsPerSample: u16le(bytes, bodyStart + 14),
  };
  if (fmt.audioFormat === 0xfffe) {
    // WAVE_FORMAT_EXTENSIBLE: o subformat é um GUID de 16 bytes. Só vale quando
    // o GUID é EXATAMENTE o padrão (PCM `00000001-0000-0010-8000-00AA00389B71`
    // ou IEEE float `00000003-…`); um prefixo coincidente com resto malformado
    // não é codec válido (R07/auditoria: nunca confiar só nos 2 primeiros bytes).
    if (size < 40 || bodyStart + 40 > bytes.length) return null;
    const guid = bytes.subarray(bodyStart + 24, bodyStart + 40);
    const matchesStandardGuid = (prefix: number): boolean =>
      guid[0] === prefix && guid[1] === 0 && guid[2] === 0 && guid[3] === 0
      && guid[4] === 0x00 && guid[5] === 0x00 && guid[6] === 0x10 && guid[7] === 0x00
      && guid[8] === 0x80 && guid[9] === 0x00 && guid[10] === 0x00 && guid[11] === 0xaa
      && guid[12] === 0x00 && guid[13] === 0x38 && guid[14] === 0x9b && guid[15] === 0x71;
    if (matchesStandardGuid(1)) fmt.subFormat = 1;
    else if (matchesStandardGuid(3)) fmt.subFormat = 3;
  }
  return fmt;
}

/** Codec PCM inteiro/float suportado para contagem exata de samples. */
function wavPcmCodec(fmt: WavFmt): number | null {
  if (fmt.audioFormat === 1 || fmt.audioFormat === 3) return fmt.audioFormat;
  if (fmt.audioFormat === 0xfffe && (fmt.subFormat === 1 || fmt.subFormat === 3)) return fmt.subFormat;
  return null;
}

const WAV_INT_BITS = new Set([8, 16, 24, 32]);
const WAV_FLOAT_BITS = new Set([32, 64]);

/**
 * Combinação codec/bits descodificável: PCM inteiro 8/16/24/32 bits e IEEE
 * float 32/64. Qualquer outra combinação (ex.: float de 8 bits) não tem
 * decoder e é rejeitada como unknown — nunca promovida a decode completo.
 */
function wavBitsSupported(codec: number, bitsPerSample: number): boolean {
  if (codec === 1) return WAV_INT_BITS.has(bitsPerSample);
  if (codec === 3) return WAV_FLOAT_BITS.has(bitsPerSample);
  return false;
}

/**
 * Layout PCM validado de um WAV (uma única fonte de verdade para medição e
 * edição de cauda). Devolve null quando o ficheiro está truncado, o codec não
 * permite contagem exata ou há incoerência de fmt/data — nunca uma duração
 * menor "a caber" por engano.
 */
export interface WavPcmLayout {
  /** codec efetivo (1=PCM inteiro, 3=IEEE float). */
  codec: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** offset do primeiro byte do payload `data`. */
  dataOffset: number;
  dataSize: number;
  /** N — samples PCM por canal. */
  sampleCount: number;
}

export function parseWavPcm(bytes: Uint8Array): WavPcmLayout | null {
  if (!bytes || bytes.length < 44) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  const riffSize = u32le(bytes, 4);
  // Tamanho declarado além do ficheiro = truncado (RIFF size cobre sizes+data).
  if (riffSize + 8 > bytes.length) return null;
  let offset = 12;
  let fmt: WavFmt | null = null;
  let dataSize = -1;
  let dataOffset = -1;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const bodyStart = offset + 8;
    if (bodyStart + size > bytes.length) return null; // chunk truncado
    if (id === "fmt " && !fmt) {
      fmt = parseWavFmt(bytes, bodyStart, size);
    } else if (id === "data" && dataSize < 0) {
      dataSize = size;
      dataOffset = bodyStart;
    }
    if (fmt && dataSize >= 0) break;
    offset = bodyStart + size + (size % 2);
  }
  if (!fmt || dataSize < 0 || dataOffset < 0) return null;
  const codec = wavPcmCodec(fmt);
  if (codec === null) return null;
  if (!wavBitsSupported(codec, fmt.bitsPerSample)) return null;
  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) return null;
  if (fmt.channels <= 0 || fmt.sampleRate <= 0) return null;
  if (fmt.blockAlign !== fmt.channels * bytesPerSample) return null;
  if (fmt.byteRate !== fmt.sampleRate * fmt.blockAlign) return null;
  if (dataSize <= 0 || dataSize % fmt.blockAlign !== 0) return null;
  return {
    codec, channels: fmt.channels, sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample, blockAlign: fmt.blockAlign,
    dataOffset, dataSize, sampleCount: dataSize / fmt.blockAlign,
  };
}

/**
 * Mede WAV PCM (8/16/24/32-bit int ou float, qualquer nº de canais). Devolve
 * null quando o ficheiro está truncado, o codec não permite contagem exata ou
 * há incoerência de fmt/data — nunca uma duração menor "a caber" por engano.
 */
export function measureWavDuration(bytes: Uint8Array): MeasuredAudio | null {
  const layout = parseWavPcm(bytes);
  if (!layout) return null;
  return {
    durationSec: round4(layout.sampleCount / layout.sampleRate),
    source: "measured-wav",
    sampleRate: layout.sampleRate,
    channels: layout.channels,
    sampleCount: layout.sampleCount,
    method: AUDIO_MEASURE_METHOD_WAV,
    decodeComplete: true,
  };
}

// ─── MP3 (cadeia de frames até EOF) ────────────────────────────────────────

const MP3_BITRATES: Record<number, number[]> = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const MP3_SAMPLERATES: Record<number, number[]> = {
  3: [44100, 48000, 32000, 0],
  2: [22050, 24000, 16000, 0],
  0: [11025, 12000, 8000, 0],
};

/** Teto de frames aceites no probe (ficheiros de voz muito longos). */
export const MP3_MAX_FRAMES = 20000;
/** Cauda máxima (bytes) entre o fim do último frame e o EOF (tags ID3v1/APE). */
const MP3_TRAILING_TAG_MAX = 128;

/**
 * Cauda legal de um MP3 completo: EOF exato depois da última frame, ou um
 * bloco de tag real no fim do ficheiro — ID3v1/ID3v1.1 (128 bytes a começar em
 * "TAG") ou APEv2 (a começar no magic "APETAGEX"). Uma frame final TRUNCADA
 * (≤128 bytes) ou bytes não identificados no fim não são descodificáveis até
 * EOF: nunca podem contar como decode completo (§4/R07).
 */
function isLegalMp3Tail(bytes: Uint8Array, lastFrameEnd: number): boolean {
  const tail = bytes.length - lastFrameEnd;
  if (tail === 0) return true;
  // "TAG" (0x54 0x41 0x47) marca o início do bloco ID3v1/ID3v1.1 de 128 bytes.
  if (tail === MP3_TRAILING_TAG_MAX
    && bytes[lastFrameEnd] === 0x54 && bytes[lastFrameEnd + 1] === 0x41 && bytes[lastFrameEnd + 2] === 0x47) return true;
  // "APETAGEX" (8 bytes) marca o fim de um bloco APEv2.
  const apetagex = [0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58];
  return tail >= apetagex.length && apetagex.every((byte, i) => bytes[lastFrameEnd + i] === byte);
}

function mp3Estimated(bytes: Uint8Array, extra?: Partial<MeasuredAudio>): MeasuredAudio {
  return {
    durationSec: round2(bytes.length / 16000),
    source: "estimated-mp3",
    decodeComplete: false,
    ...extra,
  };
}

/** Structural MPEG frame probe. No MP3 payload is certified without a decoder. */
export function measureMp3Duration(bytes: Uint8Array): MeasuredAudio | null {
  if (!bytes || bytes.length < 4) return null;
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size;
    if (offset > bytes.length) return mp3Estimated(bytes);
  }
  let frames = 0;
  let totalSamples = 0;
  let sampleRate = 0;
  let pos = offset;
  let lastFrameEnd = offset;
  let contiguous = true;
  // Gap só quebra a contiguidade quando OUTRA frame o segue (lixo a meio do
  // stream). Bytes após a última frame são a CAUDA — julgados pelo tail-check
  // (ID3v1 "TAG" de 128B no EOF é legal e não invalida o decode).
  let gapSeen = false;
  while (pos + 4 <= bytes.length && frames < MP3_MAX_FRAMES) {
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) {
      if (frames > 0) gapSeen = true;
      pos++;
      continue;
    }
    const ver = (bytes[pos + 1] >> 3) & 0x03;
    const layer = (bytes[pos + 1] >> 1) & 0x03;
    const bitrateIdx = (bytes[pos + 2] >> 4) & 0x0f;
    const srIdx = (bytes[pos + 2] >> 2) & 0x03;
    if (ver === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      if (frames > 0) gapSeen = true;
      pos++;
      continue;
    }
    const bitrate = (MP3_BITRATES[ver] ?? [])[bitrateIdx] * 1000;
    const sr = (MP3_SAMPLERATES[ver] ?? [])[srIdx];
    if (!bitrate || !sr) {
      if (frames > 0) gapSeen = true;
      pos++;
      continue;
    }
    const padding = (bytes[pos + 2] >> 1) & 0x01;
    const frameLen = ver === 3
      ? Math.floor((144 * bitrate) / sr + padding)
      : Math.floor((72 * bitrate) / sr + padding);
    if (frameLen <= 0) {
      if (frames > 0) gapSeen = true;
      pos++;
      continue;
    }
    if (pos + frameLen > bytes.length) break; // frame final truncado
    if (gapSeen) {
      // Um gap EFETIVO entre frames: bytes não descodificáveis a meio da
      // cadeia — um decoder real rejeita/pára.
      contiguous = false;
      gapSeen = false;
    }
    sampleRate = sampleRate || sr;
    totalSamples += ver === 3 ? 1152 : 576;
    frames++;
    lastFrameEnd = pos + frameLen;
    pos = lastFrameEnd;
  }
  if (frames < 2 || !sampleRate || !contiguous) return mp3Estimated(bytes);
  // C2.10/R07: a cauda tem de ser legal (EOF exato ou bloco ID3v1 real). Só o
  // TAMANHO ≤128B não prova uma tag: uma frame final truncada ou lixo no fim
  // deixaria de ser descodificável até EOF e não pode ser "decode completo".
  const complete = isLegalMp3Tail(bytes, lastFrameEnd);
  if (!complete) {
    // Cadeia interrompida a meio do ficheiro: estimado honesto, sem timing.
    return mp3Estimated(bytes, { sampleRate, sampleCount: totalSamples });
  }
  // Contiguous headers and a legal tail do not decode Layer III main_data.
  // Keep MP3 unverified until a real decoder certifies the full payload.
  return mp3Estimated(bytes, { sampleRate, sampleCount: totalSamples, method: AUDIO_MEASURE_METHOD_MP3 });
}

export function measureAudioDuration(bytes: Uint8Array, ext: "mp3" | "wav" | "m4a" | null): MeasuredAudio {
  if (ext === "wav") return measureWavDuration(bytes) ?? { durationSec: null, source: "unknown", decodeComplete: false };
  if (ext === "mp3") return measureMp3Duration(bytes) ?? { durationSec: null, source: "unknown", decodeComplete: false };
  // m4a/desconhecido: sem medição suportada nesta slice — timing_unverified.
  return { durationSec: null, source: "unknown", decodeComplete: false };
}

// ─── Mapping frames/samples (áudio-time.v1, secção 3 do contrato) ──────────

/** Estado de falha do mapping: input em segundos inválido é erro, não frame 0. */
export function secondsToFrameFloorHalfUp(
  seconds: number,
  fps: number = AUDIO_FPS,
): { ok: true; frame: number } | { ok: false; code: "FRAME_INPUT_INVALID"; detail: string } {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, code: "FRAME_INPUT_INVALID", detail: `tempo inválido: ${String(seconds)}` };
  }
  const scaled = seconds * fps + 0.5;
  if (!Number.isFinite(scaled) || scaled >= Number.MAX_SAFE_INTEGER) {
    return { ok: false, code: "FRAME_INPUT_INVALID", detail: `tempo fora do intervalo seguro: ${seconds}` };
  }
  return { ok: true, frame: Math.floor(scaled) };
}

/**
 * Frames ocupados por uma fonte completa: `ceil(N × fps × rateDen /
 * (sr × rateNum))` — racionais/inteiros, sem epsilon que esconda overflow.
 */
export function framesForSourceSamples(
  sampleCount: number,
  sampleRate: number,
  rateNum = 1,
  rateDen = 1,
  fps: number = AUDIO_FPS,
): number {
  if (!Number.isInteger(sampleCount) || sampleCount < 0) throw new Error("FRAME_MATH_INVALID_SAMPLE_COUNT");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("FRAME_MATH_INVALID_SAMPLE_RATE");
  if (!Number.isInteger(rateNum) || rateNum <= 0) throw new Error("FRAME_MATH_INVALID_RATE_NUM");
  if (!Number.isInteger(rateDen) || rateDen <= 0) throw new Error("FRAME_MATH_INVALID_RATE_DEN");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("FRAME_MATH_INVALID_FPS");
  if (sampleCount === 0) return 0;
  const numerator = sampleCount * fps * rateDen;
  const denominator = sampleRate * rateNum;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new Error("FRAME_MATH_UNSAFE");
  return Math.ceil(numerator / denominator);
}

/**
 * Sample da fronteira de split, half-up, calculado uma vez e partilhado pelos
 * dois clips: `in + roundHalfUp((splitFrame − startFrame) × sr × rateNum /
 * (fps × rateDen))`.
 */
export function sourceBoundarySample(
  startFrame: number,
  splitFrame: number,
  sampleRate: number,
  rateNum = 1,
  rateDen = 1,
  fps: number = AUDIO_FPS,
): number {
  if (!Number.isInteger(startFrame) || !Number.isInteger(splitFrame) || splitFrame < startFrame) {
    throw new Error("BOUNDARY_FRAME_INVALID");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("BOUNDARY_SAMPLE_RATE_INVALID");
  if (!Number.isInteger(rateNum) || rateNum <= 0 || !Number.isInteger(rateDen) || rateDen <= 0) {
    throw new Error("BOUNDARY_RATE_INVALID");
  }
  const numerator = (splitFrame - startFrame) * sampleRate * rateNum;
  const denominator = fps * rateDen;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new Error("BOUNDARY_MATH_UNSAFE");
  return Math.floor(numerator / denominator + 0.5);
}

// ─── Decisão única de fit (AUD-01) ─────────────────────────────────────────

export type VoiceFitFailCode = "VO_DURATION_UNMEASURED" | "VO_WINDOW_INVALID" | "VO_WINDOW_OVERFLOW";
export type VoiceFitAction = "rewrite-regenerate" | "request-duration-increase";

export interface VoiceFitArgs {
  frameNumber: number;
  /** Janela E02 [F,E) já em frames (preferida). */
  windowFrames?: number | null;
  /** Adapter legacy: janela em segundos (data-start/data-duration). */
  windowStart?: number | null;
  windowEnd?: number | null;
  /** Caminho exato E02: N samples por canal + taxa. */
  sampleCount?: number | null;
  sampleRate?: number | null;
  rateNum?: number;
  rateDen?: number;
  /** Adapter legacy: segundos medidos/estimados. */
  measuredSec?: number | null;
  /** Fonte da medida: estimated/unknown NUNCA aprovam fit. */
  durationSource?: AudioDurationSource | null;
  fps?: number;
}

export type VoiceFitDecision =
  | { ok: true; windowFrames: number; usedFrames: number; exact: boolean }
  | {
      ok: false;
      code: VoiceFitFailCode;
      detail: string;
      action: VoiceFitAction;
      windowFrames: number;
      usedFrames: number | null;
      overflowFrames: number;
      minExtensionFrames: number;
    };

function windowFramesFrom(args: VoiceFitArgs): number | null {
  if (typeof args.windowFrames === "number" && Number.isInteger(args.windowFrames) && args.windowFrames > 0) {
    return args.windowFrames;
  }
  const start = args.windowStart;
  const end = args.windowEnd;
  if (typeof start !== "number" || typeof end !== "number") return null;
  const fps = args.fps ?? AUDIO_FPS;
  const f = secondsToFrameFloorHalfUp(start, fps);
  const e = secondsToFrameFloorHalfUp(end, fps);
  if (f.ok === false || e.ok === false) return null;
  const d = e.frame - f.frame;
  return d > 0 ? d : null;
}

function voiceFitOverflow(
  frameNumber: number,
  usedFrames: number,
  windowFrames: number,
  args: VoiceFitArgs,
  sourceDesc: string,
): VoiceFitDecision {
  const over = usedFrames - windowFrames;
  const fps = args.fps ?? AUDIO_FPS;
  const windowDesc = typeof args.windowStart === "number" && typeof args.windowEnd === "number"
    ? `janela ${args.windowStart}s–${args.windowEnd}s (${windowFrames} frames)`
    : `janela ${windowFrames} frames`;
  const action: VoiceFitAction = over / fps <= 2 ? "rewrite-regenerate" : "request-duration-increase";
  const detail = `Segmento ${frameNumber}: ${sourceDesc} excede ${windowDesc} em ${over} frame(s) — `
    + (over / fps <= 2
      ? "reduzir/reescrever script e regenerar dentro do orçamento."
      : "pedir aumento de duração ou reescrever.");
  return {
    ok: false,
    code: "VO_WINDOW_OVERFLOW",
    detail,
    action,
    windowFrames,
    usedFrames,
    overflowFrames: over,
    minExtensionFrames: over,
  };
}

function voiceFitUnmeasured(frameNumber: number, windowDesc: string): VoiceFitDecision {
  return {
    ok: false,
    code: "VO_DURATION_UNMEASURED",
    detail: `Segmento ${frameNumber}: duração não medida (${windowDesc}).`,
    action: "rewrite-regenerate",
    windowFrames: 0,
    usedFrames: null,
    overflowFrames: 0,
    minExtensionFrames: 0,
  };
}

/**
 * Única decisão de fit voz↔janela (substitui tolerâncias locais +0,25s):
 * samples exatos quando disponíveis; segundos honestos só para fontes
 * `measured-*`/legado sem classificação; estimated/unknown → UNMEASURED.
 */
export function decideVoiceFit(args: VoiceFitArgs): VoiceFitDecision {
  const fps = args.fps ?? AUDIO_FPS;
  const window = windowFramesFrom(args);
  if (window === null) {
    return {
      ok: false,
      code: "VO_WINDOW_INVALID",
      detail: `Segmento ${args.frameNumber}: janela inválida/colapsada (start ${String(args.windowStart)}, end ${String(args.windowEnd)}, windowFrames ${String(args.windowFrames)}).`,
      action: "rewrite-regenerate",
      windowFrames: 0,
      usedFrames: null,
      overflowFrames: 0,
      minExtensionFrames: 0,
    };
  }
  const windowDesc = typeof args.windowStart === "number" && typeof args.windowEnd === "number"
    ? `janela ${args.windowStart}s–${args.windowEnd}s`
    : `janela ${window} frames`;

  // 1) Caminho exato: N samples + taxa (nunca reconstruir N de segundos).
  // C2.10/R07: samples de uma medida NÃO confiável (estimated/unknown) nunca
  // aprovam fit — só uma fonte medida com decode completo conta (§4: "estimated
  // /unknown nunca promovem timing"). Sem esta guarda, os samples PARCIAIS de
  // um MP3 estimado aprovavam uma janela que a voz real excede.
  const sc = args.sampleCount;
  const sr = args.sampleRate;
  const exactSourceTrusted = args.durationSource !== "estimated-mp3" && args.durationSource !== "unknown";
  if (
    exactSourceTrusted
    && typeof sc === "number" && Number.isFinite(sc) && sc >= 0
    && typeof sr === "number" && Number.isFinite(sr) && sr > 0
  ) {
    const usedFrames = framesForSourceSamples(sc, sr, args.rateNum ?? 1, args.rateDen ?? 1, fps);
    if (usedFrames <= window) return { ok: true, windowFrames: window, usedFrames, exact: true };
    return voiceFitOverflow(args.frameNumber, usedFrames, window, args, `voz ${sc} samples @${sr}Hz (${usedFrames} frames)`);
  }

  // 2) Segundos só quando a medida é confiável (measured-*/legado sem classe).
  const source = args.durationSource ?? null;
  const secondsTrusted = source === null || source === "measured-wav" || source === "measured-mp3";
  if (!secondsTrusted) return voiceFitUnmeasured(args.frameNumber, windowDesc);
  const measured = args.measuredSec;
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) {
    return voiceFitUnmeasured(args.frameNumber, windowDesc);
  }
  // Quantiza a precisão do número (2dp legado) antes do ceil — sem tolerância.
  const usedFrames = Math.ceil(Number((measured * fps).toFixed(6)));
  if (usedFrames <= window) return { ok: true, windowFrames: window, usedFrames, exact: false };
  return voiceFitOverflow(args.frameNumber, usedFrames, window, args, `voz ${measured}s (${usedFrames} frames)`);
}

/**
 * Adapter compatível (voiceFit/audioInjection/legado): a mesma decisão de fit.
 * Nunca trunca/overlap silenciosamente: ou cabe, ou pede reescrita/regeneração,
 * ou pede aumento de duração. Falha final identifica segmento/medição/janela.
 */
export function resolveLongVoice(args: {
  frameNumber: number;
  measuredSec: number | null;
  windowStart: number;
  windowEnd: number;
  windowFrames?: number | null;
  sampleCount?: number | null;
  sampleRate?: number | null;
  rateNum?: number;
  rateDen?: number;
  durationSource?: AudioDurationSource | null;
  fps?: number;
}): VoiceFitDecision {
  return decideVoiceFit({
    frameNumber: args.frameNumber,
    windowFrames: args.windowFrames,
    windowStart: args.windowStart,
    windowEnd: args.windowEnd,
    measuredSec: args.measuredSec,
    sampleCount: args.sampleCount,
    sampleRate: args.sampleRate,
    rateNum: args.rateNum,
    rateDen: args.rateDen,
    durationSource: args.durationSource,
    fps: args.fps,
  });
}
