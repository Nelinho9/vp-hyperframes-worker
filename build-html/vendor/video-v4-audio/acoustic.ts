/**
 * acoustic.ts — C04.1: fusão do alinhamento acústico na `audio_meta.json`.
 *
 * Recebe os segmentos de narração (planeamento) e os ficheiros TTS
 * materializados, mede cada ficheiro via ASR word-level e devolve:
 * - `word_timings` ABSOLUTOS (segundos de projeto) medidos;
 * - `timing_source` por segmento + agregado;
 * - proveniência (`alignment`) com adapter, cobertura e motivos de
 *   degradação — uma falha por segmento nunca contamina os restantes.
 *
 * Módulo puro dual-runtime: storage e provider são injetados.
 */
import {
  alignSpeechWords,
  type AcousticWord,
  type AsrTranscriber,
} from '../video-v4-steps/acousticAligner.ts';

export interface AlignableSegment {
  frame_number: number;
  text: string;
  start: number;
  end: number;
  word_timings?: Array<{ word: string; start: number; end: number }>;
  timing_source?: 'acoustic' | 'estimated';
  [key: string]: unknown;
}

export interface AlignableFile {
  frame_number: number;
  status: string;
  path?: string;
}

export interface AcousticSegmentResult {
  timing_source: 'acoustic' | 'estimated';
  reason?: string;
  coverage?: number;
  words?: AcousticWord[];
}

export interface AcousticMergeResult {
  narration_segments: Array<AlignableSegment & {
    word_timings?: Array<{ word: string; start: number; end: number }>;
    timing_source: 'acoustic' | 'estimated';
  }>;
  timing_source: 'acoustic' | 'estimated';
  alignment: {
    adapter: string;
    measured_at: string;
    acoustic_segments: number;
    estimated_segments: number;
    results: Array<{ frame_number: number; timing_source: 'acoustic' | 'estimated'; reason?: string; coverage?: number }>;
  };
}

const WINDOW_TOLERANCE_SEC = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Converte palavras relativas ao ficheiro em segundos absolutos da janela da
 * cena. Devolve null quando uma palavra cai fora da janela por mais do que a
 * tolerância — nesse caso o segmento degrada, nunca se "estica" a medição.
 */
export function toAbsoluteWordTimings(
  words: AcousticWord[],
  windowStart: number,
  windowEnd: number,
): Array<{ word: string; start: number; end: number }> | null {
  if (words.length === 0) return null;
  const out: Array<{ word: string; start: number; end: number }> = [];
  for (const word of words) {
    const start = windowStart + word.start;
    const end = windowStart + word.end;
    if (start < windowStart - 0.01) return null;
    if (end > windowEnd + WINDOW_TOLERANCE_SEC) return null;
    const clampedStart = clamp(start, windowStart, windowEnd);
    const clampedEnd = clamp(end, clampedStart + 0.01, windowEnd);
    if (!(clampedEnd > clampedStart)) return null;
    out.push({
      word: word.word,
      start: Math.round(clampedStart * 1000) / 1000,
      end: Math.round(clampedEnd * 1000) / 1000,
    });
  }
  return out;
}

/**
 * Mede os ficheiros ok e funde a proveniência. Nunca lança: cada segmento
 * resolve isoladamente e o agregado é `acoustic` apenas quando TODOS os
 * segmentos com texto têm medição válida.
 */
export async function mergeAcousticAlignment(args: {
  segments: AlignableSegment[];
  files: AlignableFile[];
  readBinary: (path: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  transcribe?: AsrTranscriber;
  adapter: string;
  nowIso: () => string;
  budgetMs: number;
  now?: () => number;
  log?: (msg: string) => void;
}): Promise<AcousticMergeResult> {
  const now = args.now ?? (() => Date.now());
  const startedAt = now();
  const deadline = startedAt + Math.max(0, args.budgetMs);
  const byFrame = new Map<number, AlignableFile>();
  for (const file of args.files) byFrame.set(file.frame_number, file);

  const results: AcousticMergeResult['alignment']['results'] = [];
  const narration_segments = [] as AcousticMergeResult['narration_segments'];

  for (const segment of args.segments) {
    const text = String(segment.text ?? '');
    const file = byFrame.get(segment.frame_number);
    const estimatedFallback = (reason: string) => {
      results.push({ frame_number: segment.frame_number, timing_source: 'estimated', reason });
      narration_segments.push({
        ...segment,
        ...(segment.word_timings?.length ? { word_timings: segment.word_timings } : {}),
        timing_source: 'estimated',
      });
    };

    if (!text.trim()) {
      estimatedFallback('empty-text');
      continue;
    }
    if (!args.transcribe) {
      estimatedFallback('adapter-not-configured');
      continue;
    }
    if (!file || file.status !== 'ok' || !file.path) {
      estimatedFallback('no-materialized-audio');
      continue;
    }
    if (now() >= deadline) {
      estimatedFallback('budget-exhausted');
      continue;
    }
    let audio: { bytes: Uint8Array; mimeType: string } | null = null;
    try {
      audio = await args.readBinary(file.path);
    } catch {
      audio = null;
    }
    if (!audio || audio.bytes.length === 0) {
      estimatedFallback('missing-audio-bytes');
      continue;
    }
    const alignment = await alignSpeechWords({
      transcript: text,
      audioBytes: audio.bytes,
      mimeType: audio.mimeType,
      language: 'auto',
      durationSec: Math.max(0, segment.end - segment.start),
      transcribe: args.transcribe,
      adapter: args.adapter,
    });
    if (alignment.ok === false) {
      estimatedFallback(alignment.reason);
      continue;
    }
    const absolute = toAbsoluteWordTimings(alignment.words, segment.start, segment.end);
    if (!absolute) {
      estimatedFallback('out-of-window');
      continue;
    }
    results.push({
      frame_number: segment.frame_number,
      timing_source: 'acoustic',
      coverage: alignment.coverage,
    });
    narration_segments.push({
      ...segment,
      word_timings: absolute,
      timing_source: 'acoustic',
    });
    args.log?.(`[acoustic] frame ${segment.frame_number} → acoustic (${absolute.length} palavras, cobertura ${alignment.coverage})`);
  }

  const acousticSegments = results.filter((r) => r.timing_source === 'acoustic').length;
  const estimatedSegments = results.length - acousticSegments;
  const timing_source = results.length > 0 && estimatedSegments === 0 ? 'acoustic' : 'estimated';
  return {
    narration_segments,
    timing_source,
    alignment: {
      adapter: args.adapter,
      measured_at: args.nowIso(),
      acoustic_segments: acousticSegments,
      estimated_segments: estimatedSegments,
      results,
    },
  };
}
