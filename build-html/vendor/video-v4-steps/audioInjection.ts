/**
 * audioInjection.ts — V5-P5A/P5B §2.2/§2.3: injeção DETERMINÍSTICA de tracks
 * de áudio na composição do build (voz TTS + BGM com fades).
 *
 * Os elementos entram timed ao nível da composition root:
 *   - SEM `class="clip"` — escapam ao normalizeClipWindows/lintClipWindows
 *     (invariante B2 intocado: a única sequência linear continua a ser a das
 *     cenas) e ao sumClipDurationsSec (telemetria estável). Verificado no
 *     CLI lint 0.7.109: timed <audio> sem clip class é aceite.
 *   - SEM `crossorigin` — o CLI lint rejeita (media_crossorigin_breaks_preview)
 *     e o worker pré-stageia server-side (CORS irrelevante).
 *   - VO: data-start/data-duration COPIADOS VERBATIM da cena respetiva.
 *   - BGM: janela [0, data-duration da root] + volume/fades declarativos
 *     materializados pelo bloco __vp-audio-materialized__ (audioMaterialize).
 *
 * Módulo puro dual-runtime (Deno edge + vitest/Node).
 */
import { buildAudioBlock } from './audioMaterialize.ts';
import { resolveLongVoice, type AudioDurationSource } from '../video-v4-audio/audioMeasure.ts';

export const AUDIO_TRACKS_MARKER_START = '<!-- __vp-audio-tracks:v1 -->';
export const AUDIO_TRACKS_MARKER_END = '<!-- /__vp-audio-tracks -->';
export const VO_TRACK_INDEX = '8';
export const BGM_TRACK_INDEX = '9';

export const DEFAULT_BGM_FADE_IN_MS = 1500;
export const DEFAULT_BGM_FADE_OUT_MS = 3000;

export interface AudioSceneWindow {
  id: string;
  num: number;
  startAttr: string;
  durationAttr: string;
}

export interface VoiceFileEntryLike {
  frame_number: number;
  status: string;
  path?: string;
  /** Duração TTS medida (tts.ts); null/desconhecida = legado não verificável. */
  measured_duration_sec?: number | null;
  /** E02/I1: N samples por canal + taxa (fit exato, sem +0,25s). */
  measured_sample_count?: number | null;
  measured_sample_rate?: number | null;
  duration_source?: AudioDurationSource;
  /** E02/R01: decode completo — só uma medida certificada promove timing. */
  decode_complete?: boolean | null;
}

/** V5-P5B §2.3: opções da track BGM. */
export interface BgmInjectOptions {
  src: string;
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  /**
   * Duração REAL da faixa (medida/provider). Quando é menor que a root, a
   * janela BGM nunca a excede: o fade-out termina no fim da música em vez de
   * ser agendado para depois de o ficheiro já ter acabado.
   */
  durationSec?: number;
}

// ─── Parse de cenas ────────────────────────────────────────────────────────

const CLIP_TAG_RE = /<div\b([^>]*)>/gi;

function attrValue(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
    ?? attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : null;
}

/**
 * Janelas das cenas top-level (`div.clip` com id scene-N) do documento
 * principal. Valores devolvidos como strings EXATAS dos atributos; clips com
 * janelas não numéricas são ignorados. (Sub-composições via
 * data-composition-src vivem noutros documentos e não são cobertas.)
 */
export function parseSceneWindows(html: string): AudioSceneWindow[] {
  if (typeof html !== 'string' || !html) return [];
  const out: AudioSceneWindow[] = [];
  let m: RegExpExecArray | null;
  CLIP_TAG_RE.lastIndex = 0;
  while ((m = CLIP_TAG_RE.exec(html)) !== null) {
    const attrs = m[1];
    if (!/\bclip\b/.test(attrValue(attrs, 'class') ?? '')) continue;
    if (/\bdata-composition-id\s*=/i.test(attrs)) continue; // root
    const id = attrValue(attrs, 'id') ?? '';
    const idMatch = id.match(/^scene-(\d+)$/);
    if (!idMatch) continue;
    const startAttr = attrValue(attrs, 'data-start');
    const durationAttr = attrValue(attrs, 'data-duration');
    if (startAttr === null || durationAttr === null) continue;
    if (!Number.isFinite(parseFloat(startAttr)) || !Number.isFinite(parseFloat(durationAttr))) continue;
    if (out.some((s) => s.num === Number(idMatch[1]))) continue; // primeiro ganha
    out.push({ id, num: Number(idMatch[1]), startAttr, durationAttr });
  }
  return out.sort((a, b) => a.num - b.num);
}

// ─── Tag de áudio ──────────────────────────────────────────────────────────

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const DEFAULT_VO_FADE_IN_MS = 200;
export const DEFAULT_VO_FADE_OUT_MS = 300;

/** Um elemento `<audio>` VO. Sem crossorigin, sem class clip. Fades curtos por
 *  omissão (exigência F12: transições entre faixas sem artefactos); escalados
 *  à janela como na BGM para nunca comerem a locução.
 *
 *  E04/remanescente: `data-sample-rate` só é emitido quando a taxa vem de uma
 *  medida CERTIFICADA (WAV/MP3 com decode completo). É o atributo que o
 *  parser canónico e o split consomem (E02 §3.3); sem medição o atributo não
 *  existe — nada é inventado. */
export function buildVoAudioTag(opts: {
  id: string; src: string; startAttr: string; durationAttr: string;
  fadeInMs?: number; fadeOutMs?: number;
  /** Taxa medida (Hz). Só entra no HTML quando inteira e positiva. */
  sampleRate?: number | null;
}): string {
  const durSec = parseFloat(opts.durationAttr);
  const maxFadeMs = Number.isFinite(durSec) ? Math.max(0, durSec * 1000 - 500) : 0;
  let fadeIn = Math.round(opts.fadeInMs ?? DEFAULT_VO_FADE_IN_MS);
  let fadeOut = Math.round(opts.fadeOutMs ?? DEFAULT_VO_FADE_OUT_MS);
  if (fadeIn + fadeOut > maxFadeMs && fadeIn + fadeOut > 0) {
    const k = maxFadeMs / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * k);
    fadeOut = Math.floor(fadeOut * k);
  }
  if (!Number.isFinite(fadeIn) || fadeIn < 0) fadeIn = 0;
  if (!Number.isFinite(fadeOut) || fadeOut < 0) fadeOut = 0;
  const sampleRate = typeof opts.sampleRate === 'number'
    && Number.isInteger(opts.sampleRate) && opts.sampleRate > 0
    ? opts.sampleRate
    : null;
  return `<audio id="${escapeAttr(opts.id)}" src="${escapeAttr(opts.src)}" `
    + `data-track="vo" data-track-index="${VO_TRACK_INDEX}" `
    + `data-start="${escapeAttr(opts.startAttr)}" data-duration="${escapeAttr(opts.durationAttr)}" `
    + (sampleRate !== null ? `data-sample-rate="${sampleRate}" ` : '')
    + `data-fade-in="${fadeIn}" data-fade-out="${fadeOut}" `
    + `preload="auto"></audio>`;
}

/** data-duration da composition root (string verbatim) ou null. */
export function parseRootDurationAttr(html: string): string | null {
  const open = /<div\b[^>]*data-composition-id\s*=[^>]*>/i.exec(html);
  if (!open) return null;
  const d = attrValue(open[0], 'data-duration');
  if (d === null || !Number.isFinite(parseFloat(d))) return null;
  return d;
}

/**
 * V5-P5B §2.3: tag BGM — janela [0, duração da root], volume estático e
 * fades declarativos (materializados em tweens pelo bloco estático).
 */
export function buildBgmTag(opts: {
  src: string;
  rootDurationAttr: string;
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  durationSec?: number;
}): string {
  const rootSec = parseFloat(opts.rootDurationAttr);
  if (!Number.isFinite(rootSec) || rootSec <= 0) return '';
  const trackSec = typeof opts.durationSec === 'number' && Number.isFinite(opts.durationSec) && opts.durationSec > 0
    ? opts.durationSec
    : null;
  // Arredonda UMA vez: o atributo emitido e a janela dos fades têm de ser o
  // mesmo número (o materializador lê o atributo, não o float interno).
  const clamp = trackSec !== null && trackSec < rootSec;
  const effectiveSec = trackSec !== null && trackSec < rootSec ? Math.round(trackSec * 1000) / 1000 : rootSec;
  // Sem clamp, o atributo da root fica VERBATIM (contrato histórico e testes
  // byte-exatos); com clamp, emite a duração real da faixa sem ruído binário.
  const durationAttr = clamp ? String(effectiveSec) : opts.rootDurationAttr;
  const maxFadeMs = Math.max(0, effectiveSec * 1000 - 500);
  let fadeIn = Math.round(opts.fadeInMs ?? DEFAULT_BGM_FADE_IN_MS);
  let fadeOut = Math.round(opts.fadeOutMs ?? DEFAULT_BGM_FADE_OUT_MS);
  if (fadeIn + fadeOut > maxFadeMs && fadeIn + fadeOut > 0) {
    const k = maxFadeMs / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * k);
    fadeOut = Math.floor(fadeOut * k);
  }
  if (!Number.isFinite(fadeIn) || fadeIn < 0) fadeIn = 0;
  if (!Number.isFinite(fadeOut) || fadeOut < 0) fadeOut = 0;
  const volume = Math.min(1, Math.max(0, opts.volume ?? 0.3));
  return `<audio id="bgm-main" src="${escapeAttr(opts.src)}" `
    + `data-track="bgm" data-track-index="${BGM_TRACK_INDEX}" `
    + `data-start="0" data-duration="${escapeAttr(durationAttr)}" `
    + `data-volume="${volume}" data-fade-in="${fadeIn}" data-fade-out="${fadeOut}" `
    + `preload="auto"></audio>`;
}

// ─── Injeção ───────────────────────────────────────────────────────────────

/** Remove o bloco marcado existente (upsert idempotente). */
function stripMarkedBlock(html: string): string {
  const start = html.indexOf(AUDIO_TRACKS_MARKER_START);
  if (start === -1) return html;
  const endIdx = html.indexOf(AUDIO_TRACKS_MARKER_END, start);
  if (endIdx === -1) return html.slice(0, start);
  return html.slice(0, start) + html.slice(endIdx + AUDIO_TRACKS_MARKER_END.length);
}

/** Índice do `</div>` que fecha a primeira composition root (scanner depth). */
function findRootCloseIndex(html: string): number {
  const open = /<div\b[^>]*data-composition-id\s*=[^>]*>/i.exec(html);
  if (!open) return -1;
  let depth = 1;
  const tokenRe = /<\/?div\b[^>]*?>/gi;
  tokenRe.lastIndex = open.index + open[0].length;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(html)) !== null) {
    const isOpen = t[0][1] !== '/';
    if (!isOpen) {
      depth -= 1;
      if (depth === 0) return t.index;
    } else if (!/\/>$/.test(t[0])) {
      // <div ... /> auto-fechado não abre profundidade
      depth += 1;
    }
  }
  return -1;
}

export function injectAudioTracks(
  html: string,
  opts: {
    files: VoiceFileEntryLike[];
    resolveSrc: (path: string) => string | null;
    /** V5-P5B: track BGM opcional (catálogo real, src no worker). */
    bgm?: BgmInjectOptions | null;
  },
): { html: string; injected: number; bgmInjected: boolean } {
  if (typeof html !== 'string' || !html) return { html, injected: 0, bgmInjected: false };

  const withoutBlock = stripMarkedBlock(html);

  // Áudio autorado fora dos marcadores (vo|bgm) → nunca duplicar.
  const hasVo = /data-track\s*=\s*["']vo["']/i.test(withoutBlock);
  const hasBgm = /data-track\s*=\s*["']bgm["']/i.test(withoutBlock);

  const files = Array.isArray(opts?.files) ? opts.files : [];
  const bgm = opts?.bgm ?? null;
  if (files.length === 0 && !(bgm && bgm.src)) {
    return { html: withoutBlock === html ? html : withoutBlock, injected: 0, bgmInjected: false };
  }

  const rootDurationAttr = parseRootDurationAttr(withoutBlock);

  const tags: string[] = [];
  let voCount = 0;

  if (files.length > 0 && !hasVo) {
    const scenes = parseSceneWindows(withoutBlock);
    const byFrame = new Map<number, AudioSceneWindow>();
    for (const s of scenes) if (!byFrame.has(s.num)) byFrame.set(s.num, s);

    /** contador voice-K por cena */
    const perSceneCounter = new Map<number, number>();
    for (const file of files) {
      if (!file || typeof file.frame_number !== 'number' || file.status !== 'ok' || !file.path) continue;
      const scene = byFrame.get(file.frame_number);
      if (!scene) continue;
      // Reparo voz F12 + E02/I1: UMA decisão de fit (samples exatos quando
      // medidos; sem tolerância de +0,25s). Entradas novas sem medição
      // (estimated/unknown) falham explícito; só legado sem qualquer
      // evidência de medida segue com aviso honesto.
      const measured = typeof file.measured_duration_sec === 'number' ? file.measured_duration_sec : null;
      const sampleCount = typeof file.measured_sample_count === 'number' ? file.measured_sample_count : null;
      const sampleRate = typeof file.measured_sample_rate === 'number' ? file.measured_sample_rate : null;
      const durationSource = typeof file.duration_source === 'string' ? file.duration_source as AudioDurationSource : null;
      // E04: só uma medida CONFIAVEL (measured-wav|measured-mp3 com decode
      // completo) pode emitir `data-sample-rate`. `estimated/unknown`/ausente
      // mantém o caminho frame-exact do split, sem atributo inventado.
      const decodeComplete = typeof file.decode_complete === 'boolean' ? file.decode_complete : null;
      const certifiedSampleRate = sampleRate !== null
        && Number.isInteger(sampleRate) && sampleRate > 0
        && (durationSource === 'measured-wav' || durationSource === 'measured-mp3')
        && decodeComplete !== false
        ? sampleRate
        : null;
      const winStart = parseFloat(scene.startAttr);
      const winDur = parseFloat(scene.durationAttr);
      const hasEvidence = measured !== null || sampleCount !== null || durationSource !== null;
      if (hasEvidence && Number.isFinite(winStart) && Number.isFinite(winDur)) {
        const fit = resolveLongVoice({
          frameNumber: file.frame_number,
          measuredSec: measured,
          sampleCount,
          sampleRate,
          durationSource,
          windowStart: winStart,
          windowEnd: winStart + winDur,
        });
        if (fit.ok === false) {
          throw new Error(`${fit.code}: ${fit.detail}`);
        }
      } else {
        console.error(`[build] VO sem medição (legado, não verificado): frame ${file.frame_number} — segue sem gate de ajuste`);
      }
      const src = opts.resolveSrc(file.path);
      if (!src) continue;
      const k = (perSceneCounter.get(file.frame_number) ?? 0) + 1;
      perSceneCounter.set(file.frame_number, k);
      tags.push(buildVoAudioTag({
        id: `scene-${file.frame_number}-voice-${k}`,
        src,
        startAttr: scene.startAttr,
        durationAttr: scene.durationAttr,
        sampleRate: certifiedSampleRate,
      }));
      voCount += 1;
    }
  }

  // BGM precisa de root com duração utilizável.
  const bgmTag = !hasBgm && bgm && bgm.src && rootDurationAttr
    ? buildBgmTag({ src: bgm.src, rootDurationAttr, volume: bgm.volume, fadeInMs: bgm.fadeInMs, fadeOutMs: bgm.fadeOutMs, durationSec: bgm.durationSec })
    : null;
  if (bgmTag) tags.push(bgmTag);

  if (tags.length === 0) return { html: withoutBlock === html ? html : withoutBlock, injected: 0, bgmInjected: false };

  const closeIdx = findRootCloseIndex(withoutBlock);
  if (closeIdx === -1) return { html: withoutBlock === html ? html : withoutBlock, injected: 0, bgmInjected: false };

  // Bloco materializador só quando há fades declarativos (hoje: BGM).
  const hasFades = tags.some((t) => t.includes('data-fade-in') || t.includes('data-fade-out'));
  const audioTags = hasFades ? `${tags.join('\n')}\n${buildAudioBlock()}` : tags.join('\n');
  const block = `${AUDIO_TRACKS_MARKER_START}\n${audioTags}\n${AUDIO_TRACKS_MARKER_END}`;
  const nextHtml = `${withoutBlock.slice(0, closeIdx)}${block}${withoutBlock.slice(closeIdx)}`;
  return { html: nextHtml, injected: voCount, bgmInjected: Boolean(bgmTag) };
}

/**
 * F03.6: SFX injection — sem capability real nesta fase.
 * `sfx:on` deve ser rejeitado a montante (audioStep) com SFX_NOT_SUPPORTED;
 * esta helper documenta a ausência e nunca injeta SFX fantasma.
 */
export const SFX_INJECTION_SUPPORTED = false as const;

export function resolveSfxInjection(sfx: string): { ok: true; injected: false } | { ok: false; code: string; detail: string } {
  if (sfx !== "on") return { ok: true, injected: false };
  return {
    ok: false,
    code: "SFX_NOT_SUPPORTED",
    detail: "SFX:on sem capability real (sem asset ID/proveniência/licença/timing/gain/fade). Usa sfx:off/auto.",
  };
}
