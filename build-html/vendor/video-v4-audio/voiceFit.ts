/**
 * voiceFit.ts — Reparo voz F12: TTS medido maior que a janela NUNCA entra
 * mudo em silêncio. Reescreve o script mais curto (LLM, significado
 * preservado) e regenera o TTS (máx. 2 tentativas); se continuar a exceder,
 * falha EXPLÍCITA por segmento (VO_WINDOW_OVERFLOW) em vez de corte a meio
 * da palavra no render.
 *
 * Módulo puro dual-runtime (Deno edge + vitest/Node): LLM e TTS injetados.
 */

import { resolveLongVoice, type AudioDurationSource } from "./audioMeasure.ts";

/** Tentativas totais de síntese por segmento (original + 2 reescritas).
 * F12-qualificação: 2 tentativas esgotavam-se com reescritas rejeitadas por
 * excesso de chars em janelas curtas. */
export const VOICE_FIT_MAX_ATTEMPTS = 3;

/** Heurística conservadora para a reescrita (chars/s). F12-qualificação: 13 é
 * taxa EN; PT mede ~8.5-11c/s no TTS real (projeto 36967e02: 30c→3.52s,
 * 50c→5.52s) — com 13, textos conformes chumbavam sempre. */
export const VOICE_FIT_CHARS_PER_SEC = 13;

/** Taxa por idioma (normalizado, sem região). Desconhecido → 13 (EN). */
export function charsPerSecForLang(lang: string | null | undefined): number {
  const base = String(lang ?? '').toLowerCase().split('-')[0];
  if (base === 'pt') return 9;
  return VOICE_FIT_CHARS_PER_SEC;
}

export interface FitWindow {
  frame_number: number;
  text: string;
  windowStart: number;
  windowEnd: number;
  /** E02: janela já em frames [F,E) quando o caller os tem exatos. */
  windowFrames?: number;
}

export interface FitFile {
  frame_number: number;
  status: string;
  measured_duration_sec?: number | null;
  /** E02: N samples por canal + taxa (caminho exato da medição). */
  measured_sample_count?: number | null;
  measured_sample_rate?: number | null;
  duration_source?: AudioDurationSource;
  rewrites?: number;
  error?: string;
}

export interface FitCallbacks {
  /** Devolve texto mais curto (mesmo idioma, sentido preservado) ou null. */
  llmRewrite(frameNumber: number, text: string, maxChars: number): Promise<string | null>;
  /** Ressintetiza e devolve os campos atualizados da entry (status/medida). */
  resynthesize(frameNumber: number, text: string): Promise<Record<string, unknown>>;
  log?(msg: string): void;
  /** Taxa de fala para o budget de chars (omissa = 13 EN). */
  charsPerSec?: number;
  /**
   * F2 T10 — retries da reescrita por overflow (transientes: throw/timeout).
   * Default 2 (3 tentativas totais por ciclo). `null` devolvido = rejeição
   * permanente (fora do contrato) → falha explícita sem retry.
   */
  maxRewriteRetries?: number;
  /** Backoff entre retries (ms ou fn; default exponencial 500·2^(n-1), cap 4s). */
  rewriteDelayMs?: number | ((attempt: number) => number);
  /** Espera injetável (testes); default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * F2 T10 — fallback sem rewrite (default true): esgotados os retries
   * transientes, preserva o wav original válido (`ok`) com warning
   * `VOICE_FIT_REWRITE_UNAVAILABLE` em vez de descartar 3 wavs válidos
   * como em M3. `false` mantém falha explícita estrita.
   */
  fallbackToOriginal?: boolean;
}

export interface FitResult {
  files: FitFile[];
  /** frame → texto final falado (reescrito ou original). */
  finalTexts: Record<number, string>;
  rewrote: number;
  failures: Array<{ frame_number: number; code: string; detail: string }>;
  /**
   * F2 T10 — avisos não-bloqueantes: original preservado após retries
   * transientes esgotados (`VOICE_FIT_REWRITE_UNAVAILABLE`). O pipeline
   * prossegue com overflow documentado; nunca descarta wav válido.
   */
  warnings: Array<{ frame_number: number; code: string; detail: string }>;
}

export function voiceRewritePrompt(text: string, windowSec: number, maxChars: number): string {
  return `Shorten this video narration to fit ${windowSec}s of speech (max ${maxChars} characters), preserving meaning and language. `
    + `One single sentence. PLAIN TEXT ONLY — never JSON, never keys, never quotes around the whole sentence, no preamble, no explanation. `
    + `Your entire reply must be exactly the revised sentence and nothing else.\n\nOriginal (${text.length} chars): ${text}`;
}

/**
 * Extrai texto falável da resposta do LLM (incidente real 2026-10-12: o modelo
 * devolveu `{"revised_text": "..."}` e o blob JSON foi parar ao TTS/legendas).
 * Aceita texto simples ou objeto JSON com chave revised_text/text/sentence;
 * rejeita (null) qualquer coisa que não seja frase simples dentro do orçamento.
 */
export function extractSpokenText(raw: string, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!text) return null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const candidate = (parsed as Record<string, unknown>)?.revised_text
        ?? (parsed as Record<string, unknown>)?.text
        ?? (parsed as Record<string, unknown>)?.sentence;
      if (typeof candidate !== 'string') return null;
      text = candidate.trim();
    } catch {
      return null;
    }
  }
  text = text.replace(/^["“”']+|["“”']+$/g, '').trim();
  if (!text) return null;
  // Recusa restos estruturais: chaves, chavetas, prefixos de etiqueta.
  if (text.includes('{') || text.includes('}') || text.includes('[') || text.includes(']')) return null;
  if (/^\s*(revised_text|text|sentence)\s*:/i.test(text)) return null;
  if (text.length > maxChars) return null;
  if (/^https?:\/\//i.test(text)) return null;
  return text;
}

export async function fitVoiceFilesToWindows(
  windows: FitWindow[],
  files: FitFile[],
  cb: FitCallbacks,
): Promise<FitResult> {
  const out: FitFile[] = files.map((f) => ({ ...f }));
  const finalTexts: Record<number, string> = {};
  const failures: FitResult["failures"] = [];
  const warnings: FitResult["warnings"] = [];
  let rewrote = 0;
  const maxRewriteRetries = Number.isInteger(cb.maxRewriteRetries) && (cb.maxRewriteRetries as number) >= 0
    ? (cb.maxRewriteRetries as number)
    : 2;
  const fallbackToOriginal = cb.fallbackToOriginal !== false;
  const sleepFn = cb.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayFor = (attempt: number): number => {
    if (typeof cb.rewriteDelayMs === 'function') return Math.max(0, cb.rewriteDelayMs(attempt));
    if (typeof cb.rewriteDelayMs === 'number' && Number.isFinite(cb.rewriteDelayMs)) return Math.max(0, cb.rewriteDelayMs);
    return Math.min(4000, 500 * 2 ** Math.max(0, attempt - 1));
  };

  for (const w of windows) {
    const file = out.find((f) => f.frame_number === w.frame_number);
    if (!file || file.status !== "ok") continue;
    let currentText = w.text;
    finalTexts[w.frame_number] = currentText;

    for (let attempt = 1; attempt <= VOICE_FIT_MAX_ATTEMPTS; attempt++) {
      // E02 §4: uma única decisão de fit (samples exatos quando existem;
      // nunca +0,25s). Estimated/unknown → UNMEASURED.
      const check = resolveLongVoice({
        frameNumber: w.frame_number,
        windowFrames: w.windowFrames,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        measuredSec: typeof file.measured_duration_sec === "number" ? file.measured_duration_sec : null,
        sampleCount: typeof file.measured_sample_count === "number" ? file.measured_sample_count : null,
        sampleRate: typeof file.measured_sample_rate === "number" ? file.measured_sample_rate : null,
        durationSource: file.duration_source ?? null,
      });
      if (check.ok === true) break;
      if (check.code === "VO_DURATION_UNMEASURED" || check.code === "VO_WINDOW_INVALID") {
        // Timing não verificado nunca entra como ok: falha explícita por
        // segmento (rewrite não resolve falta de medida/janela inválida).
        file.status = "failed";
        file.error = `${check.code}: ${check.detail}`;
        failures.push({ frame_number: w.frame_number, code: check.code, detail: String(file.error) });
        break;
      }
      if (attempt >= VOICE_FIT_MAX_ATTEMPTS) {
        file.status = "failed";
        file.error = `${check.code}: ${check.detail} (após ${attempt} tentativa(s), sem corte silencioso)`;
        failures.push({ frame_number: w.frame_number, code: check.code, detail: String(file.error) });
        break;
      }
      const windowSec = Math.max(0.5, w.windowEnd - w.windowStart);
      const rate = cb.charsPerSec && Number.isFinite(cb.charsPerSec) && cb.charsPerSec > 0
        ? cb.charsPerSec
        : VOICE_FIT_CHARS_PER_SEC;
      const maxChars = Math.max(20, Math.floor(windowSec * rate));
      // F2 T10: retry só em TRANSIENTE (throw/timeout). `null` = rejeição
      // permanente do contrato (fora de orçamento, JSON, não encurtou) → sem
      // retry, falha explícita como antes.
      let shorter: string | null = null;
      let transientExhausted = false;
      let lastTransient: string | null = null;
      for (let r = 1; r <= maxRewriteRetries + 1; r++) {
        try {
          shorter = await cb.llmRewrite(w.frame_number, currentText, maxChars);
          break;
        } catch (err) {
          lastTransient = String((err as Error)?.message ?? err);
          cb.log?.(`[voiceFit] rewrite LLM transiente (frame ${w.frame_number}, try ${r}/${maxRewriteRetries + 1}): ${lastTransient}`);
          if (r > maxRewriteRetries) {
            transientExhausted = true;
            break;
          }
          const delay = delayFor(r);
          if (delay > 0) {
            try {
              await sleepFn(delay);
            } catch {
              /* sleep nunca falha o fit */
            }
          }
        }
      }
      if (transientExhausted) {
        // Throw/timeout esgotado (transiente, caso M3): fallback preserva o
        // wav válido; só falha explícito com fallback desligado.
        if (fallbackToOriginal) {
          const detail = `${check.code}: ${check.detail} (rewrite LLM indisponível após ${maxRewriteRetries + 1} tentativa(s): ${lastTransient ?? 'timeout'}; wav original preservado, sem corte silencioso)`;
          warnings.push({ frame_number: w.frame_number, code: 'VOICE_FIT_REWRITE_UNAVAILABLE', detail });
          cb.log?.(`[voiceFit] frame ${w.frame_number} fallback sem rewrite: original preservado`);
          break;
        }
        file.status = "failed";
        file.error = `${check.code}: ${check.detail} (reescrita LLM indisponível após ${maxRewriteRetries + 1} tentativa(s): ${lastTransient ?? 'timeout'})`;
        failures.push({ frame_number: w.frame_number, code: check.code, detail: String(file.error) });
        break;
      }
      if (!shorter || !shorter.trim()) {
        file.status = "failed";
        file.error = `${check.code}: ${check.detail} (reescrita LLM indisponível)`;
        failures.push({ frame_number: w.frame_number, code: check.code, detail: String(file.error) });
        break;
      }
      currentText = shorter.trim();
      finalTexts[w.frame_number] = currentText;
      try {
        const next = await cb.resynthesize(w.frame_number, currentText);
        Object.assign(file, next, { frame_number: w.frame_number });
        file.rewrites = (typeof file.rewrites === "number" ? file.rewrites : 0) + 1;
        rewrote += 1;
        cb.log?.(`[voiceFit] frame ${w.frame_number} reescrito (${currentText.length} chars), medido ${String((next as { measured_duration_sec?: unknown }).measured_duration_sec ?? "?")}s`);
      } catch (err) {
        file.status = "failed";
        file.error = `TTS_RESYNTH_FAILED: frame ${w.frame_number}: ${String((err as Error)?.message ?? err)}`;
        failures.push({ frame_number: w.frame_number, code: "TTS_RESYNTH_FAILED", detail: String(file.error) });
        break;
      }
    }
  }

  return { files: out, finalTexts, rewrote, failures, warnings };
}
