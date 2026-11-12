/** Real Suno BGM: persist the paid task, reuse it on retry, fail explicitly. */
import { fetchBuffered } from '../_shared/boundedTransport.ts';
import { createRespanFetch } from '../_shared/respanTracing.ts';
import { measureAudioDuration } from './audioMeasure.ts';
import { detectAudioExtFromBytes } from './tts.ts';

interface MusicStorage {
  readText(path: string): Promise<string | null>;
  writeText(path: string, value: string): Promise<void>;
  writeTextIfAbsent?(path: string, value: string): Promise<boolean>;
  writeBinary?(path: string, bytes: Uint8Array, type: string): Promise<void>;
  /** C04.2: leitura binária — reutilização da faixa já materializada. */
  readBinary?(path: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}
export interface MusicIo {
  storage: MusicStorage;
  apiKey: string;
  model: string;
  variant: string;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs: number;
}

/**
 * Suno's `duration` is a TARGET: the returned track can be slightly shorter
 * (observed 14,76 s / 14,83 s for a 15 s request). A shortfall up to this
 * tolerance is inaudible because the build clamps the BGM window to the real
 * track duration and the fade-out completes exactly at that point. Anything
 * larger fails explicitly instead of shipping a silent music tail.
 */
export const MUSIC_COVERAGE_TOLERANCE_SEC = 0.5;

export interface ProviderMusicTrack {
  audio_url: string;
  duration_sec: number | null;
}

interface MusicReceipt {
  status?: string;
  task_id?: string;
  request_hash?: string;
  bgm?: Record<string, unknown>;
  /** Provider status is in `status`; the last content decision is separate. */
  decision?: string;
  code?: string | number;
  detail?: string;
}

type MusicError = Error & { detail: string };

function musicError(code: string, detail: string): MusicError {
  const error = new Error(code) as MusicError;
  error.detail = detail;
  return error;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonOrNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tracksFromArray(value: unknown): ProviderMusicTrack[] {
  if (!Array.isArray(value)) return [];
  const tracks: ProviderMusicTrack[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    if (!item) continue;
    const audioUrl = typeof item.audio_url === 'string'
      ? item.audio_url
      : typeof item.audioUrl === 'string' ? item.audioUrl : null;
    if (!audioUrl || !audioUrl.startsWith('https://')) continue;
    const duration = Number(item.duration);
    tracks.push({
      audio_url: audioUrl,
      duration_sec: Number.isFinite(duration) && duration > 0 ? duration : null,
    });
  }
  return tracks;
}

/**
 * The documented recordInfo contract (`data.response.data[]`) and the shape
 * the provider actually returns (`data.response.resultObject.lyricsData[]`)
 * differ. Accept both (and the callback-style `data.data[]`) so a provider
 * payload change never turns a valid paid track into "no track".
 */
function tracksFromPayload(value: unknown): ProviderMusicTrack[] {
  const root = asRecord(jsonOrNull(value));
  if (!root) return [];
  const resultObject = asRecord(root.resultObject);
  const response = asRecord(root.response);
  const responseResultObject = asRecord(response?.resultObject);
  const callbackData = asRecord(root.data);
  const candidates = [
    root.data,
    root.lyricsData,
    resultObject?.data,
    resultObject?.lyricsData,
    response?.data,
    responseResultObject?.data,
    responseResultObject?.lyricsData,
    callbackData?.data,
    callbackData?.lyricsData,
  ];
  for (const candidate of candidates) {
    const tracks = tracksFromArray(candidate);
    if (tracks.length > 0) return tracks;
  }
  return [];
}

/** Reads both poll fields (`response` object/string and `resultJson` string). */
export function extractMusicTracks(record: Record<string, unknown>): ProviderMusicTrack[] {
  // The third candidate makes a callback body (`{ data: { data: [...] } }`)
  // readable through the same entry point without changing the poll path.
  for (const candidate of [record.response, record.resultJson, record]) {
    const tracks = tracksFromPayload(candidate);
    if (tracks.length > 0) return tracks;
  }
  return [];
}

/**
 * Actual file duration. WAV is exact; MP3 is structural (frames × samples,
 * never promoted to a decode-certified voice measurement). Returns null when
 * the container cannot be probed — the provider duration is then the only
 * value and the caller can still decide honestly.
 */
function probeMusicDuration(bytes: Uint8Array, ext: 'mp3' | 'wav' | 'm4a' | null): { seconds: number | null; source: string } {
  const measured = measureAudioDuration(bytes, ext);
  if (measured.source === 'measured-wav' && typeof measured.durationSec === 'number' && measured.durationSec > 0) {
    return { seconds: measured.durationSec, source: measured.source };
  }
  if (
    measured.source === 'estimated-mp3'
    && typeof measured.sampleCount === 'number'
    && typeof measured.sampleRate === 'number'
    && measured.sampleRate > 0
  ) {
    return { seconds: Math.round((measured.sampleCount / measured.sampleRate) * 1000) / 1000, source: measured.source };
  }
  return { seconds: null, source: measured.source };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildSunoMusicRequest(args: { model: string; variant: string; mood: string; duration: number }) {
  if (args.model !== 'ai-music-api/generate' || !['V6', 'V6_MINI', 'V6_WILD'].includes(args.variant)) throw new Error('MUSIC_CONFIG_INVALID');
  if (!Number.isFinite(args.duration) || args.duration <= 0 || args.duration > 360) throw new Error('MUSIC_DURATION_UNSUPPORTED');
  return { model: args.model, input: {
    model: args.variant, custom_mode: true, instrumental: true,
    title: 'Video background instrumental',
    style: `Instrumental background score for a professional video ad. ${args.mood || 'Warm modern uplifting minimal'}. Clear opening, gentle build, clean ending. Leave space for narration. No vocals, speech, chanting or sung words.`.slice(0, 1000),
    negative_tags: 'vocals, speech, singing, lyrics, chanting, abrupt ending',
    duration: Math.max(10, Math.ceil(args.duration)),
  } };
}

export async function materializeProjectMusic(io: MusicIo, projectId: string, music: 'auto' | 'on' | 'off'): Promise<{ path?: string; taskId?: string; skipped?: boolean }> {
  const metaPath = `projects/${projectId}/audio_meta.json`;
  const raw = await io.storage.readText(metaPath);
  if (!raw) throw new Error('MUSIC_AUDIO_META_MISSING');
  const meta = JSON.parse(raw);
  if (music === 'off') {
    meta.bgm = null;
    await io.storage.writeText(metaPath, JSON.stringify(meta));
    return { skipped: true };
  }
  // C04.2: uma faixa Suno já materializada DENTRO deste projeto é reutilizada
  // (clone/retry) — `music:on` continua a exigir o pipeline completo.
  const existingPath = typeof meta.bgm?.path === 'string' ? meta.bgm.path : '';
  const projectPrefix = `projects/${projectId}/audio/`;
  if (music !== 'on' && existingPath.startsWith(projectPrefix) && io.storage.readBinary) {
    const existing = await io.storage.readBinary(existingPath).catch(() => null);
    if (existing && existing.bytes.length > 0) {
      console.log(`[video-v4-audio] BGM reutilizada de ${existingPath} (${existing.bytes.length}B)`);
      return { path: existingPath, skipped: true };
    }
  }
  if (!io.apiKey || !io.storage.writeTextIfAbsent || !io.storage.writeBinary) throw new Error('MUSIC_CONFIG_MISSING');
  const mood = String(meta.music_plan?.mood || meta.bgm?.mood || 'warm modern uplifting minimal');
  const request = buildSunoMusicRequest({ model: io.model, variant: io.variant, mood, duration: Number(meta.total_duration_sec) });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request))));
  const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  const prefix = `projects/${projectId}/audio/music/${hash}`;
  const receiptPath = `${prefix}/job.json`;
  const now = io.now ?? Date.now;
  const deadline = now() + Math.max(0, io.budgetMs);
  if (deadline <= now()) throw new Error('MUSIC_GENERATION_PENDING');
  const fetcher = createRespanFetch(io.fetcher ?? fetch, { name: 'video.music.submit' });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${io.apiKey}` };
  const read = (url: string, init: RequestInit, maxBytes = 2 * 1024 * 1024) => {
    const left = deadline - now();
    if (left <= 0) throw new Error('MUSIC_GENERATION_PENDING');
    return fetchBuffered(fetcher, url, init, Math.min(left, 30_000), maxBytes);
  };
  const existing = await io.storage.readText(receiptPath);
  let receipt: MusicReceipt | null = null;
  if (existing) {
    try {
      receipt = JSON.parse(existing) as MusicReceipt;
    } catch {
      receipt = null;
    }
  }
  if (!receipt) {
    const won = await io.storage.writeTextIfAbsent(receiptPath, JSON.stringify({ status: 'submitting', request_hash: hash }));
    if (!won) throw new Error('MUSIC_GENERATION_PENDING');
    // No createTask retry: an interrupted paid submission is uncertain.
    const response = await read('https://api.kie.ai/api/v1/jobs/createTask', { method: 'POST', headers, body: JSON.stringify(request) });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.code !== 200 || !data?.data?.taskId) {
      const code = Number(data?.code) === 402 ? 'MUSIC_PROVIDER_CREDITS_INSUFFICIENT' : 'MUSIC_PROVIDER_FAILED';
      const detail = String(data?.msg || `provider submission failed (HTTP ${response.status})`).slice(0, 500);
      await io.storage.writeText(receiptPath, JSON.stringify({ status: 'failed', code, detail, request_hash: hash }));
      throw musicError(code, detail);
    }
    receipt = { status: 'generating', task_id: data.data.taskId, request_hash: hash };
    await io.storage.writeText(receiptPath, JSON.stringify(receipt));
  }
  if (receipt.status === 'failed') {
    // Old receipts may carry a numeric HTTP/provider code; map it to the
    // generic code the previous version surfaced.
    const code = typeof receipt.code === 'string' && receipt.code ? receipt.code : 'MUSIC_PROVIDER_FAILED';
    const detail = receipt.detail ?? 'the paid provider task failed on a previous attempt';
    console.error(`[video-v4-audio] music receipt failed: ${code} — ${detail}`);
    throw musicError(code, detail);
  }
  if (!receipt.task_id) throw new Error('MUSIC_SUBMISSION_UNCERTAIN');
  if (receipt.status === 'complete' && receipt.bgm?.path) {
    // Re-read like the success path: a concurrent voice write must survive.
    const latest = JSON.parse(await io.storage.readText(metaPath) || raw);
    latest.bgm = receipt.bgm;
    await io.storage.writeText(metaPath, JSON.stringify(latest));
    return { path: String(receipt.bgm.path), taskId: receipt.task_id };
  }
  /**
   * The provider task reached success but its content is unusable. Keep
   * `status: generating` (the paid task stays operationally reachable) and
   * record the decision separately; a retry re-polls the same task instead of
   * requiring deletion of the receipt (which would pay for a new task).
   */
  const markUnusable = async (current: MusicReceipt, code: string, detail: string): Promise<never> => {
    await io.storage.writeText(receiptPath, JSON.stringify({ ...current, status: 'generating', decision: 'unusable', code, detail }));
    throw musicError(code, detail);
  };
  const requiredSec = Number(meta.total_duration_sec);
  while (now() < deadline) {
    const response = await read(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(receipt.task_id)}`, { headers });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 200) throw new Error('MUSIC_STATUS_UNAVAILABLE');
    const result = payload.data;
    if (result?.state === 'fail') {
      const detail = String(result?.failMsg || result?.failCode || 'provider reported state=fail');
      await io.storage.writeText(receiptPath, JSON.stringify({ ...receipt, status: 'failed', code: 'MUSIC_PROVIDER_FAILED', detail }));
      throw musicError('MUSIC_PROVIDER_FAILED', detail);
    }
    if (result?.state === 'success') {
      // The documented shape is `response.data[]`, but the live provider
      // returns `response.resultObject.lyricsData[]`. Normalize both before
      // deciding anything: a missing key is not a missing/short track.
      const tracks = extractMusicTracks(result as Record<string, unknown>);
      if (tracks.length === 0) {
        return await markUnusable(receipt, 'MUSIC_RESULT_MISSING', 'provider reached state=success but the payload has no usable audio_url track');
      }
      // Longest first, then fall through the other variations: the provider
      // duration is a target, so metadata can be rounded while the bytes of
      // the sibling track actually cover the composition.
      const ranked = [...tracks].sort((a, b) => (b.duration_sec ?? -1) - (a.duration_sec ?? -1));
      let accepted: {
        track: ProviderMusicTrack;
        bytes: Uint8Array;
        ext: 'mp3' | 'wav';
        probe: { seconds: number | null; source: string };
        trackSec: number;
        shortfallSec: number;
      } | null = null;
      let bestShort: { shortfallSec: number; detail: string } | null = null;
      let otherFailure: { code: string; detail: string } | null = null;
      for (const track of ranked) {
        const media = await read(track.audio_url, {}, 20 * 1024 * 1024);
        if (!media.ok) throw new Error('MUSIC_DOWNLOAD_FAILED');
        const bytes = new Uint8Array(await media.arrayBuffer());
        const ext = detectAudioExtFromBytes(bytes);
        if (!['mp3', 'wav'].includes(ext ?? '') || bytes.length < 128) {
          otherFailure ??= { code: 'MUSIC_INVALID_AUDIO', detail: `invalid audio container (${ext ?? 'unknown'}, ${bytes.length} bytes)` };
          continue;
        }
        const probe = probeMusicDuration(bytes, ext);
        // A WAV must decode exactly; falling back to the provider number for a
        // truncated WAV would write broken bytes and trust a duration that the
        // file cannot back. MP3 has no decoder in the Edge runtime, so the
        // provider value remains the honest fallback there.
        if (ext === 'wav' && probe.seconds === null) {
          otherFailure ??= { code: 'MUSIC_INVALID_AUDIO', detail: 'wav payload is truncated or has no measurable PCM data' };
          continue;
        }
        const trackSec = probe.seconds ?? track.duration_sec;
        if (trackSec === null || !Number.isFinite(requiredSec) || requiredSec <= 0) {
          otherFailure ??= { code: 'MUSIC_RESULT_DURATION_UNKNOWN', detail: `track duration unknown (provider=${String(track.duration_sec)}s, probe=${probe.source})` };
          continue;
        }
        const shortfallSec = Math.max(0, requiredSec - trackSec);
        if (shortfallSec > MUSIC_COVERAGE_TOLERANCE_SEC) {
          if (!bestShort || shortfallSec < bestShort.shortfallSec) {
            bestShort = {
              shortfallSec,
              detail: `track ${trackSec}s is shorter than the composition ${requiredSec}s by ${round3(shortfallSec)}s (tolerance ${MUSIC_COVERAGE_TOLERANCE_SEC}s)`,
            };
          }
          continue;
        }
        accepted = { track, bytes, ext: ext as 'mp3' | 'wav', probe, trackSec, shortfallSec };
        break;
      }
      if (!accepted) {
        if (bestShort) return await markUnusable(receipt, 'MUSIC_RESULT_TOO_SHORT', bestShort.detail);
        if (otherFailure) return await markUnusable(receipt, otherFailure.code, otherFailure.detail);
        return await markUnusable(receipt, 'MUSIC_RESULT_MISSING', 'provider reached state=success but no track could be used');
      }
      const chosen = accepted;
      const audioPath = `${prefix}/bgm.${chosen.ext}`;
      await io.storage.writeBinary(audioPath, chosen.bytes, chosen.ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
      const bgm = { path: audioPath, mood, duration_sec: chosen.trackSec,
        required_duration_sec: requiredSec,
        coverage_shortfall_sec: round3(chosen.shortfallSec),
        provider_duration_sec: chosen.track.duration_sec,
        duration_source: chosen.probe.seconds !== null ? chosen.probe.source : 'provider',
        volume: meta.narration_enabled === false ? 0.35 : 0.18, provider: 'kie-suno', model: io.variant, task_id: receipt.task_id };
      const latest = JSON.parse(await io.storage.readText(metaPath) || raw);
      latest.bgm = bgm;
      latest.music_plan = { mood, status: 'complete' };
      const completed = { ...receipt, status: 'complete', bgm };
      delete completed.decision;
      delete completed.code;
      delete completed.detail;
      await io.storage.writeText(receiptPath, JSON.stringify(completed));
      await io.storage.writeText(metaPath, JSON.stringify(latest));
      return { path: audioPath, taskId: receipt.task_id };
    }
    const delay = Math.min(3000, Math.max(0, deadline - now()));
    await (io.sleep ? io.sleep(delay) : new Promise(r => setTimeout(r, delay)));
  }
  throw new Error('MUSIC_GENERATION_PENDING');
}
