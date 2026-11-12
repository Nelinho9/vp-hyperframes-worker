import { createRespanFetch } from '../_shared/respanTracing.ts';

/**
 * acousticAligner.ts — C04.1: alinhamento acústico REAL palavra-a-palavra.
 *
 * Substitui a estimativa matemática (`i / words.length`) por timestamps
 * MEDIDOS sobre o áudio TTS materializado. Contrato:
 *
 * - `acoustic` só existe com palavras medidas, monotónicas, dentro da janela
 *   e com cobertura >= 85% dos tokens do guião;
 * - qualquer falha do provider (rede, 4xx/5xx, timeout, shape desconhecida,
 *   cobertura insuficiente) degrada para `estimated` com `reason` — nunca
 *   lança, nunca falsifica a proveniência;
 * - módulo PURO dual-runtime (Deno edge + vitest/Node): fetch/sleep/now são
 *   injetados, o provider é substituível nos testes.
 *
 * Doc: docs/PLANO_ESTRATEGICO_CEO_2026-11-03/FASE_C04_LEGENDAS_ACUSTICAS_E_DOBRAGEM_MULTILINGUA.md
 */

/** Cobertura mínima de tokens do guião para aceitar a medição. */
export const ACOUSTIC_MIN_COVERAGE = 0.85;
/**
 * Modelo ASR por omissão (Replicate) — override por `V4_ASR_MODEL`.
 * COM-11 (prova real 2026-11-11): `openai/whisper` no Replicate NÃO expõe
 * word-level timestamps (o schema não tem `timestamp_granularities`; esse
 * parâmetro é da API da OpenAI, não deste modelo Cog) — a criação falhava
 * 404/429 e todos os segmentos degradavam para `estimated`. O whisperx da
 * comunidade com `align_output:true` mede palavras reais (multilingue).
 */
export const ACOUSTIC_DEFAULT_MODEL = 'victor-upmeet/whisperx';
/** Identificador honesto do adapter gravado na proveniência. */
export const ACOUSTIC_ADAPTER_ID = 'replicate-whisperx-word-ts';

/**
 * Provider ASR PREFERIDO (decisão do operador 2026-11-12): kie.ai Nemotron
 * Transcribe. Mantém o fluxo de áudio na kie.ai (como TTS/BGM), mede palavras
 * reais (`timestamps:true` → words[].start/end + diarização), é multilingue e
 * barato (~0.005 créditos/s). Prova paga 2026-11-12: transcrição exata, 2s para
 * 47s de áudio. O Replicate (`ACOUSTIC_DEFAULT_MODEL`) fica como fallback
 * reversível via `V4_ASR_PROVIDER=replicate`.
 */
export const KIE_ASR_DEFAULT_MODEL = 'nvidia/nemotron-3-5-transcribe';
/** Identificador honesto do adapter kie.ai gravado na proveniência. */
export const KIE_ASR_ADAPTER_ID = 'kie-nemotron-transcribe-word-ts';

export interface AcousticWord {
  word: string;
  /** Segundos relativos ao INÍCIO do ficheiro de voz do segmento. */
  start: number;
  end: number;
  confidence: number | null;
}

export type AcousticAlignment =
  | {
    ok: true;
    adapter: string;
    words: AcousticWord[];
    coverage: number;
    confidence: number | null;
  }
  | { ok: false; adapter: string; reason: string };

export type AsrTranscriber = (args: {
  bytes: Uint8Array;
  mimeType: string;
  language: string;
}) => Promise<unknown>;

// ─── Normalização / tokens ─────────────────────────────────────────────────

/** Minúsculas, sem pontuação/acento-insensível para comparação de tokens. */
export function normalizeWordToken(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9çñßøåæœ']/g, '')
    .trim();
}

export function transcriptTokens(text: string): string[] {
  return String(text ?? '')
    .split(/\s+/)
    .map(normalizeWordToken)
    .filter(Boolean);
}

/**
 * Cobertura ORDENADA: cada token do guião tem de ser encontrado na sequência
 * ASR (com tolerância a contrações/pontuação). Devolve matched/total.
 */
export function computeCoverage(words: AcousticWord[], transcript: string): number {
  const expected = transcriptTokens(transcript);
  if (expected.length === 0) return 0;
  const found = words.map((w) => normalizeWordToken(w.word)).filter(Boolean);
  let cursor = 0;
  let matched = 0;
  for (const token of expected) {
    let hit = -1;
    for (let i = cursor; i < found.length; i++) {
      if (found[i] === token) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      matched += 1;
      cursor = hit + 1;
    }
  }
  return Math.round((matched / expected.length) * 1000) / 1000;
}

// ─── Parser de payloads ASR ────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function readWord(raw: unknown): AcousticWord | null {
  const item = asRecord(raw);
  if (!item) return null;
  const word = typeof item.word === 'string'
    ? item.word
    : typeof item.text === 'string' ? item.text : '';
  const start = num(item.start ?? item.start_time ?? item.startTime);
  const end = num(item.end ?? item.end_time ?? item.endTime);
  if (!word.trim() || start === null || end === null) return null;
  const score = num(item.score ?? item.confidence ?? item.probability);
  return {
    word: word.trim(),
    start,
    end,
    confidence: score === null ? null : Math.min(1, Math.max(0, score)),
  };
}

function pushWords(target: AcousticWord[], raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    const parsed = readWord(entry);
    if (parsed) target.push(parsed);
  }
}

/**
 * Aceita as formas conhecidas de resposta word-level (Replicate whisper /
 * whisperx / chunks com `timestamp: [start, end]`). Shape desconhecida
 * devolve [] — o chamador degrada com `reason`, nunca inventa tempos.
 */
export function parseAsrWords(payload: unknown): AcousticWord[] {
  const root = asRecord(payload);
  if (!root) return [];
  const words: AcousticWord[] = [];

  // Forma plana: { word_segments: [...] } / { words: [...] }
  pushWords(words, root.word_segments);
  pushWords(words, root.words);

  // Forma por segmentos: { segments: [{ words: [...] }] } / { output: {...} }
  const segments = Array.isArray(root.segments)
    ? root.segments
    : asRecord(root.output)?.segments;
  if (Array.isArray(segments)) {
    for (const segment of segments) {
      const item = asRecord(segment);
      if (!item) continue;
      if (Array.isArray(item.words)) {
        pushWords(words, item.words);
        continue;
      }
      // Chunks whisper nativo: { text, timestamp: [start, end] }
      const ts = item.timestamp;
      if (Array.isArray(ts) && ts.length === 2) {
        const start = num(ts[0]);
        const end = num(ts[1]);
        if (start !== null && end !== null && typeof item.text === 'string' && item.text.trim()) {
          for (const token of item.text.trim().split(/\s+/)) {
            words.push({ word: token, start, end, confidence: null });
          }
        }
      }
    }
  }
  // `output` pode ser string JSON (alguns modelos emitem string).
  if (words.length === 0 && typeof root.output === 'string') {
    try {
      return parseAsrWords(JSON.parse(root.output));
    } catch {
      return [];
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

// ─── Validação ─────────────────────────────────────────────────────────────

export function validateAcousticTimings(args: {
  words: AcousticWord[];
  durationSec: number | null;
}): { ok: true } | { ok: false; reason: string } {
  const { words, durationSec } = args;
  if (words.length === 0) return { ok: false, reason: 'no-words' };
  let previousEnd = -Infinity;
  for (const word of words) {
    if (!word.word.trim()) return { ok: false, reason: 'empty-word' };
    if (!(word.end > word.start)) return { ok: false, reason: 'non-positive-span' };
    if (word.start < previousEnd - 1e-3) return { ok: false, reason: 'non-monotonic' };
    if (word.start < 0) return { ok: false, reason: 'negative-start' };
    if (durationSec !== null && Number.isFinite(durationSec) && word.end > durationSec + 0.25) {
      return { ok: false, reason: 'beyond-duration' };
    }
    previousEnd = word.end;
  }
  return { ok: true };
}

/**
 * Executa o adapter com degradação honesta. Nunca lança: qualquer exceção
 * vira `{ ok:false, reason:'adapter-failed:...' }`.
 */
export async function alignSpeechWords(args: {
  transcript: string;
  audioBytes: Uint8Array;
  mimeType: string;
  language: string;
  durationSec: number | null;
  transcribe: AsrTranscriber;
  adapter?: string;
}): Promise<AcousticAlignment> {
  const adapter = args.adapter ?? ACOUSTIC_ADAPTER_ID;
  if (!args.transcript.trim()) return { ok: false, adapter, reason: 'empty-transcript' };
  if (!args.audioBytes || args.audioBytes.length === 0) {
    return { ok: false, adapter, reason: 'no-audio-bytes' };
  }
  let payload: unknown;
  try {
    payload = await args.transcribe({
      bytes: args.audioBytes,
      mimeType: args.mimeType,
      language: args.language,
    });
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 120);
    return { ok: false, adapter, reason: `adapter-failed:${message || 'unknown'}` };
  }
  const words = parseAsrWords(payload);
  const timing = validateAcousticTimings({ words, durationSec: args.durationSec });
  if (timing.ok === false) return { ok: false, adapter, reason: timing.reason };
  const coverage = computeCoverage(words, args.transcript);
  if (coverage < ACOUSTIC_MIN_COVERAGE) {
    return { ok: false, adapter, reason: `low-coverage:${coverage}` };
  }
  const scored = words.filter((w) => typeof w.confidence === 'number');
  const confidence = scored.length === 0
    ? null
    : Math.round((scored.reduce((acc, w) => acc + (w.confidence ?? 0), 0) / scored.length) * 1000) / 1000;
  return { ok: true, adapter, words, coverage, confidence };
}

/** Estimativa de planeamento (uniforme) — usada só quando não há medição. */
export function buildEstimatedWordTimings(
  text: string,
  start: number,
  end: number,
): Array<{ word: string; start: number; end: number }> {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !(end > start)) return [];
  return words.map((word, i) => ({
    word,
    start: start + (end - start) * i / words.length,
    end: start + (end - start) * (i + 1) / words.length,
  }));
}

// ─── Provider (Replicate) ──────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked para nunca rebentar o limite de argumentos.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function audioDataUri(bytes: Uint8Array, mimeType: string): string {
  const mime = mimeType && mimeType.startsWith('audio/') ? mimeType : 'audio/mpeg';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string | null;
}

/**
 * Transcrição word-level via Replicate (whisperx + `align_output`). O shape
 * da resposta NÃO é assumido: `parseAsrWords` valida no chamador e um shape
 * inesperado degrada para `estimated` — o provider nunca pode corromper a
 * proveniência.
 *
 * COM-11 (prova real 2026-11-11): criação com backoff limitado para 429/5xx
 * (o provider throttleia rajadas) e fallback 404 → versão explícita via
 * `POST /v1/predictions` (modelos cujo endpoint por nome não está disponível).
 */
export function createReplicateAsrTranscriber(args: {
  apiToken: string;
  fetchImpl?: typeof fetch;
  model?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}): AsrTranscriber {
  const fetchImpl = createRespanFetch(args.fetchImpl ?? fetch, { name: 'video.acoustic-alignment' });
  const model = args.model ?? ACOUSTIC_DEFAULT_MODEL;
  const pollIntervalMs = args.pollIntervalMs ?? 1500;
  const maxPolls = args.maxPolls ?? 60;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async ({ bytes, mimeType, language }) => {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiToken}`,
    };
    // Contrato whisperx: audio_file (data URI), align_output:true mede
    // palavras reais; task/language explícitos (sem tradução).
    const input = {
      audio_file: audioDataUri(bytes, mimeType),
      align_output: true,
      task: 'transcribe',
      language: language && language !== 'auto' ? language.split('-')[0] : undefined,
    };
    const createOnce = (url: string, body: Record<string, unknown>) =>
      fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    // Backoff para throttle/erros de servidor; 4xx permanentes (401/402/422)
    // falham já — nunca mascarar o defeito. COM-11 (prova real): a Replicate
    // limita a criação de predictions (6/min, burst 1 com crédito < $5) e
    // devolve `Retry-After` em segundos — respeitá-lo é o que evita o 429
    // persistente quando os segmentos são criados em rajada.
    const createWithRetry = async (url: string, body: Record<string, unknown>) => {
      let response = await createOnce(url, body);
      for (let attempt = 0; attempt < 5 && (response.status === 429 || response.status >= 500); attempt++) {
        const retryAfterSec = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000 + 500
          : 1000 * Math.pow(2, attempt);
        await sleep(waitMs);
        response = await createOnce(url, body);
      }
      return response;
    };
    let created = await createWithRetry(`https://api.replicate.com/v1/models/${model}/predictions`, { input });
    if (created.status === 404) {
      const meta = await fetchImpl(`https://api.replicate.com/v1/models/${model}`, { headers });
      if (meta.ok) {
        const version = ((await meta.json()) as { latest_version?: { id?: string } }).latest_version?.id;
        if (version) {
          created = await createWithRetry('https://api.replicate.com/v1/predictions', { version, input });
        }
      }
    }
    if (!created.ok) {
      throw new Error(`ASR_CREATE_HTTP_${created.status}`);
    }
    let prediction = (await created.json()) as ReplicatePrediction;
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      if (prediction.status === 'succeeded') return prediction.output;
      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        throw new Error(`ASR_${prediction.status.toUpperCase()}${prediction.error ? `:${prediction.error}` : ''}`);
      }
      if (!prediction.id) throw new Error('ASR_NO_PREDICTION_ID');
      await sleep(pollIntervalMs);
      const polled = await fetchImpl(`https://api.replicate.com/v1/predictions/${prediction.id}`, { headers });
      if (!polled.ok) throw new Error(`ASR_POLL_HTTP_${polled.status}`);
      prediction = (await polled.json()) as ReplicatePrediction;
    }
    args.log?.(`[acousticAligner] prediction ${prediction.id ?? '?'} still running after ${maxPolls} polls`);
    throw new Error('ASR_POLL_EXHAUSTED');
  };
}

// ─── Provider (kie.ai — Nemotron Transcribe) ───────────────────────────────

const KIE_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';
const KIE_CREATE_TASK_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
const KIE_RECORD_INFO_URL = 'https://api.kie.ai/api/v1/jobs/recordInfo';

interface KieUploadResponse {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { downloadUrl?: string } | null;
}
interface KieCreateResponse {
  code?: number;
  msg?: string;
  data?: { taskId?: string } | null;
}
interface KieRecordResponse {
  code?: number;
  msg?: string;
  data?: {
    state?: string;
    response?: unknown;
    resultJson?: string;
    failMsg?: string | null;
  } | null;
}

/**
 * Transcrição word-level via kie.ai (`nvidia/nemotron-3-5-transcribe`).
 * Fluxo (prova paga 2026-11-12): o modelo RECUSA URLs externos ("audio_url
 * file type not supported"), por isso o áudio é primeiro carregado no CDN da
 * kie.ai (File Upload API) e só esse URL é passado ao `createTask`.
 *
 * `timestamps:true` mede palavras reais (words[].start/end + speaker). NÃO se
 * passa `target_language`: o schema proíbe combiná-lo com timestamps e, para
 * legendas, queremos a língua FALADA (o modelo deteta-a automaticamente).
 *
 * O shape da resposta NÃO é assumido: devolve o JSON word-level bruto e
 * `parseAsrWords` valida no chamador — um shape inesperado degrada para
 * `estimated`, o provider nunca corrompe a proveniência.
 */
export function createKieAsrTranscriber(args: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}): AsrTranscriber {
  const fetchImpl = createRespanFetch(args.fetchImpl ?? fetch, { name: 'video.acoustic-alignment.kie' });
  const model = args.model ?? KIE_ASR_DEFAULT_MODEL;
  const pollIntervalMs = args.pollIntervalMs ?? 1500;
  const maxPolls = args.maxPolls ?? 80;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${args.apiKey}`,
  };
  return async ({ bytes, mimeType }) => {
    // 1) Upload do áudio para o CDN da kie.ai (data URI base64, ≤10MB).
    const ext = mimeType === 'audio/wav' ? 'wav' : mimeType === 'audio/mpeg' ? 'mp3' : 'audio';
    const uploadRes = await fetchImpl(KIE_UPLOAD_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base64Data: audioDataUri(bytes, mimeType),
        uploadPath: 'audio/v4-asr',
        fileName: `segment.${ext}`,
      }),
    });
    if (!uploadRes.ok) throw new Error(`ASR_KIE_UPLOAD_HTTP_${uploadRes.status}`);
    const upload = (await uploadRes.json()) as KieUploadResponse;
    const audioUrl = upload.data?.downloadUrl;
    if (upload.code !== 200 || !audioUrl) {
      throw new Error(`ASR_KIE_UPLOAD:${upload.msg ?? 'no-url'}`.slice(0, 120));
    }

    // 2) createTask com timestamps (word-level), sem tradução.
    const createRes = await fetchImpl(KIE_CREATE_TASK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: { audio_url: audioUrl, timestamps: true } }),
    });
    const created = (await createRes.json()) as KieCreateResponse;
    const taskId = created.data?.taskId;
    if (!createRes.ok || created.code !== 200 || !taskId) {
      throw new Error(`ASR_KIE_CREATE:${created.code ?? createRes.status}:${created.msg ?? ''}`.slice(0, 120));
    }

    // 3) Poll recordInfo até estado terminal (success/fail).
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      await sleep(pollIntervalMs);
      const pollRes = await fetchImpl(`${KIE_RECORD_INFO_URL}?taskId=${taskId}`, { headers });
      if (!pollRes.ok) throw new Error(`ASR_KIE_POLL_HTTP_${pollRes.status}`);
      const polled = (await pollRes.json()) as KieRecordResponse;
      if (polled.code !== 200) {
        throw new Error(`ASR_KIE_POLL:${polled.code}:${polled.msg ?? ''}`.slice(0, 120));
      }
      const data = polled.data ?? {};
      const state = String(data.state ?? '');
      if (state === 'fail') {
        throw new Error(`ASR_KIE_FAIL:${String(data.failMsg ?? '').slice(0, 80)}`);
      }
      if (state === 'success') {
        // 4) O word-level vive num JSON apontado por resultObject.url. Esse
        //    URL é público (CDN) — NÃO enviar Authorization para não vazar a
        //    key para um host terceiro.
        const resp = (data.response
          ?? (typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : null)) as Record<string, unknown> | null;
        const resultObject = resp && typeof resp === 'object'
          ? resp.resultObject as Record<string, unknown> | undefined
          : undefined;
        const wordsUrl = resultObject && typeof resultObject.url === 'string' ? resultObject.url : null;
        if (wordsUrl) {
          const wordsRes = await fetchImpl(wordsUrl, { headers: {} });
          if (!wordsRes.ok) throw new Error(`ASR_KIE_WORDS_HTTP_${wordsRes.status}`);
          return await wordsRes.json();
        }
        // Fallback: palavras inline (o parser tolera { words: [...] }).
        return resultObject ?? resp;
      }
    }
    args.log?.(`[acousticAligner] kie task ${taskId} still running after ${maxPolls} polls`);
    throw new Error('ASR_KIE_POLL_EXHAUSTED');
  };
}
