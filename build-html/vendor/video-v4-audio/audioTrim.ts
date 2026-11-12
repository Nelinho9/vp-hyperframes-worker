/**
 * audioTrim.ts — E07: ajuste de cauda para caber na janela SEM truncar voz.
 *
 * Achado E07 (projeto A, cena 4): a voz medida excedia a janela em 8 frames,
 * mas a fala terminava ~0,38 s antes do EOF — a diferença era SILÊNCIO final
 * do provider. Cortar o ficheiro no fim (truncagem) perderia fala; cortar a
 * cauda silenciosa até à janela preserva todas as palavras.
 *
 * Regras (falham fechado, nunca "aproveitam" por engano):
 *  - só WAV PCM com decode completo e `data` a terminar no EOF;
 *  - só remove amostras DEPOIS do último bloco acima do limiar (RMS 20 ms,
 *    -50 dBFS por omissão), com um guard mínimo de cauda audível;
 *  - se a própria fala não couber, não toca nos bytes (`speech-overflow`);
 *  - devolve sempre a medida antes/depois para o recibo.
 */
import { parseWavPcm, type WavPcmLayout } from './audioMeasure.ts';

export const TAIL_TRIM_DEFAULT_DBFS = -50;
export const TAIL_TRIM_DEFAULT_WINDOW_MS = 20;
export const TAIL_TRIM_DEFAULT_MIN_TAIL_MS = 120;

export interface TailFitOptions {
  /** samples por canal que a janela admite (já em número inteiro). */
  maxSamples: number;
  thresholdDbfs?: number;
  windowMs?: number;
  minTailMs?: number;
}

export type TailFitReason =
  | 'not-wav'
  | 'data-not-last'
  | 'already-fits'
  | 'speech-overflow'
  | 'all-silence'
  | 'no-reduction'
  | 'applied';

export interface TailFitResult {
  applied: boolean;
  reason: TailFitReason;
  bytes: Uint8Array;
  originalSampleCount: number;
  keptSampleCount: number;
  speechEndSample: number;
  trimmedMs: number;
  thresholdDbfs: number;
}

function sampleReader(bytes: Uint8Array, layout: WavPcmLayout): (frame: number) => number {
  const { dataOffset, blockAlign, channels, bitsPerSample, codec } = layout;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chan = Math.min(channels, 2);
  return (frame: number): number => {
    let sum = 0;
    for (let c = 0; c < chan; c++) {
      const at = dataOffset + frame * blockAlign + c * (bitsPerSample / 8);
      if (codec === 3) {
        sum += bitsPerSample === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      } else if (bitsPerSample === 8) {
        sum += (bytes[at] - 128) / 128;
      } else if (bitsPerSample === 16) {
        sum += view.getInt16(at, true) / 32768;
      } else if (bitsPerSample === 24) {
        // 24-bit little endian com extensão de sinal.
        const raw = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
        sum += ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388608;
      } else {
        sum += view.getInt32(at, true) / 2147483648;
      }
    }
    return sum / chan;
  };
}

function rebuild(bytes: Uint8Array, layout: WavPcmLayout, keepSamples: number): Uint8Array {
  const keepBytes = keepSamples * layout.blockAlign;
  const out = bytes.slice(0, layout.dataOffset + keepBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(4, out.length - 8, true); // RIFF size
  view.setUint32(layout.dataOffset - 4, keepBytes, true); // data chunk size
  return out;
}

/** Último sample (fim do bloco) acima do limiar RMS; 0 quando tudo é silêncio. */
function lastAudibleSample(read: (frame: number) => number, sampleCount: number, sampleRate: number, windowMs: number, threshold: number): number {
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  let last = 0;
  for (let start = 0; start < sampleCount; start += windowSamples) {
    const end = Math.min(sampleCount, start + windowSamples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = read(i);
      sum += v * v;
    }
    if (Math.sqrt(sum / (end - start)) >= threshold) last = end;
  }
  return last;
}

/**
 * Corta apenas a cauda silenciosa que excede `maxSamples`. Nunca mexe num
 * ficheiro que caiba, nem quando a fala em si excede a janela.
 */
export function fitWavTailToWindow(bytes: Uint8Array, opts: TailFitOptions): TailFitResult {
  const thresholdDbfs = opts.thresholdDbfs ?? TAIL_TRIM_DEFAULT_DBFS;
  const windowMs = opts.windowMs ?? TAIL_TRIM_DEFAULT_WINDOW_MS;
  const minTailMs = opts.minTailMs ?? TAIL_TRIM_DEFAULT_MIN_TAIL_MS;
  const unchanged = (reason: TailFitReason, original: number, speechEnd: number): TailFitResult => ({
    applied: false, reason, bytes, originalSampleCount: original,
    keptSampleCount: original, speechEndSample: speechEnd, trimmedMs: 0, thresholdDbfs,
  });

  const layout = parseWavPcm(bytes);
  if (!layout) return unchanged('not-wav', 0, 0);
  const original = layout.sampleCount;
  // Só se corta a cauda: chunks depois de `data` (tags) não são reescritos.
  if (layout.dataOffset + layout.dataSize !== bytes.length) return unchanged('data-not-last', original, 0);

  const threshold = Math.pow(10, thresholdDbfs / 20);
  const read = sampleReader(bytes, layout);
  const speechEnd = lastAudibleSample(read, original, layout.sampleRate, windowMs, threshold);
  if (speechEnd === 0) return unchanged('all-silence', original, 0);
  if (original <= opts.maxSamples) return unchanged('already-fits', original, speechEnd);

  const minTail = Math.round((layout.sampleRate * minTailMs) / 1000);
  // A regra dura: NUNCA remover um bloco classificado como audível. O guard de
  // cauda é uma PREFERÊNCIA (quando há espaço), nunca um veto que force recusa
  // quando a fala termina exatamente na janela — aí só existe ruído abaixo do
  // limiar para remover.
  if (speechEnd > opts.maxSamples) return unchanged('speech-overflow', original, speechEnd);

  // Mantém o máximo possível (com preferência de guard quando cabe).
  const keep = Math.min(opts.maxSamples, speechEnd + minTail);
  if (keep >= original) return unchanged('no-reduction', original, speechEnd);
  return {
    applied: true, reason: 'applied', bytes: rebuild(bytes, layout, keep),
    originalSampleCount: original, keptSampleCount: keep, speechEndSample: speechEnd,
    trimmedMs: Math.round(((original - keep) * 1000) / layout.sampleRate), thresholdDbfs,
  };
}
