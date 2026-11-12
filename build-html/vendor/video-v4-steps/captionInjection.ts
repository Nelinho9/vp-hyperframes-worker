/**
 * captionInjection.ts — F03.9 + C04.1: cues com bounds, texto escapado,
 * timing_source explícito, base responsiva por ratio e highlight
 * palavra-a-palavra nos 3 presets dinâmicos (hormozi / editorial / karaoke).
 *
 * Sem fallback universal de 32px: 16:9→28px, 1:1→30px, 9:16→36px.
 * Sem VO, exige semântica editorial aprovada (não transcrição).
 *
 * C04.1: quando `narration_segments[].word_timings` trazem tempos medidos
 * (`timing_source: "acoustic"`), cada palavra recebe um span próprio e a
 * timeline GSAP alterna `data-active` exatamente no início/fim medidos —
 * seek-safe e determinístico. Sem word timings, mantém-se o cue de frase.
 */
import { parseSceneWindows } from "./audioInjection.ts";
import {
  captionBaseForRatio,
  captionPresetCss,
  captionWordsPerCue,
  escapeCaptionText,
  normalizeCaptionPreset,
  type CaptionPreset,
  type CaptionTimingSource,
} from "./captionStyle.ts";

export interface CaptionSegment {
  frame_number: number; text: string; start: number; end: number;
  word_timings?: Array<{ word: string; start: number; end: number; timing_source?: CaptionTimingSource }>;
  timing_source?: CaptionTimingSource;
}
const START = "<!-- __vp-captions:v1 -->";
const END = "<!-- /__vp-captions -->";
const STYLE_START = "<!-- __vp-caption-style:v1 -->";
const STYLE_END = "<!-- /__vp-caption-style -->";

/** Remove blocos legados de legendas/estilo (idempotência antes de reinjetar). */
function stripBlocks(html: string): string {
  let clean = html;
  for (const [start, end] of [[START, END], [STYLE_START, STYLE_END]] as const) {
    for (;;) {
      const from = clean.indexOf(start);
      const to = from >= 0 ? clean.indexOf(end, from) : -1;
      if (from < 0 || to < 0) break;
      clean = clean.slice(0, from) + clean.slice(to + end.length);
    }
  }
  return clean;
}

export function injectCaptions(
  html: string,
  meta: {
    captions_enabled?: boolean;
    narration_segments?: CaptionSegment[];
    timing_source?: CaptionTimingSource;
    caption_style?: string;
    ratio?: string;
    editorialApproved?: boolean;
    hasVo?: boolean;
  },
): string {
  const clean = stripBlocks(html);
  const preset: CaptionPreset = normalizeCaptionPreset(meta.caption_style);
  // Historical projects did not have this explicit flag. Do not change them.
  if (meta.captions_enabled !== true) return clean;
  // F03.9: sem VO, exige semântica editorial aprovada.
  const hasVo = meta.hasVo ?? (Array.isArray(meta.narration_segments) && meta.narration_segments.length > 0);
  if (!hasVo && meta.editorialApproved !== true) {
    // Sem VO nem editorial aprovado: não injeta transcrição fantasma.
    // Chamador deve aprovar editorial ou ligar narration (erro a montante).
    // Aqui remove derivados obsoletos e segue sem captions (off-like).
    return clean;
  }
  const root = /<div\b[^>]*data-composition-id\s*=\s*["'"'"']([\w-]+)["'"'"'][^>]*>/i.exec(clean);
  if (!root) return clean;
  const rootTag = root[0];
  const wM = rootTag.match(/\bdata-width\s*=\s*"([^"]*)"/i);
  const hM = rootTag.match(/\bdata-height\s*=\s*"([^"]*)"/i);
  const w = wM ? parseInt(wM[1], 10) : 1080;
  const h = hM ? parseInt(hM[1], 10) : 1920;
  const ratio = meta.ratio ?? (w === 1920 && h === 1080 ? "16:9" : w === 1080 && h === 1080 ? "1:1" : "9:16");
  const base = captionBaseForRatio(ratio);
  const scenes = parseSceneWindows(clean);
  const wordsPerCue = captionWordsPerCue(preset);
  const cues: Array<{
    text: string;
    start: number;
    end: number;
    source: CaptionTimingSource;
    words: Array<{ word: string; start: number; end: number }>;
  }> = [];
  for (const seg of meta.narration_segments ?? []) {
    const scene = scenes.find((s) => s.num === seg.frame_number);
    if (!scene) continue;
    const floor = Number(scene.startAttr);
    const ceil = floor + Number(scene.durationAttr);
    if (!Number.isFinite(floor) || !Number.isFinite(ceil) || !(ceil > floor)) continue;
    const segSource: CaptionTimingSource = seg.timing_source ?? meta.timing_source ?? "estimated";
    const words = seg.word_timings ?? [];
    if (!words.length) {
      const start = Math.max(floor, seg.start);
      const end = Math.min(ceil, seg.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && seg.text.trim()) {
        cues.push({ text: seg.text, start, end, source: segSource, words: [] });
      }
      continue;
    }
    for (let i = 0; i < words.length; i += wordsPerCue) {
      const group = words.slice(i, i + wordsPerCue);
      const start = Math.max(floor, group[0].start);
      const end = Math.min(ceil, group[group.length - 1].end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const src: CaptionTimingSource = (group[0] as { timing_source?: CaptionTimingSource }).timing_source ?? segSource;
        cues.push({
          text: group.map((x) => x.word).join(" "),
          start,
          end,
          source: src,
          words: group.map((x) => ({
            word: x.word,
            start: Math.max(start, Math.min(end, x.start)),
            end: Math.max(start, Math.min(end, x.end)),
          })),
        });
      }
    }
  }
  if (!cues.length) return clean;
  let wordIndex = 0;
  const cueSpans: string[] = [];
  const cueWordIds: string[][] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const wordIds: string[] = [];
    const inner = cue.words.length > 0
      ? cue.words.map((word) => {
        const id = `vp-word-${wordIndex++}`;
        wordIds.push(id);
        return `<span class="vp-word" id="${id}" data-active="0">${escapeCaptionText(word.word)}</span>`;
      }).join(" ")
      : escapeCaptionText(cue.text);
    cueWordIds.push(wordIds);
    cueSpans.push(
      `<span id="vp-caption-cue-${i}" class="vp-caption" data-vp-caption-cue data-preset="${preset}" data-timing-source="${cue.source}" style="position:absolute;left:5%;right:5%;bottom:${base.bottomPct}%;z-index:100;opacity:${cue.start === 0 ? 1 : 0};text-align:center;pointer-events:none;font:600 ${base.fontPx}px/1.4 sans-serif;color:#fff;background:#101018f2;border-radius:12px;padding:12px 20px;">${inner}</span>`,
    );
  }
  const timelineSteps: string[] = [];
  cues.forEach((cue, i) => {
    timelineSteps.push(
      `tl.set("#vp-caption-cue-${i}",{opacity:${cue.start === 0 ? 1 : 0}},0).set("#vp-caption-cue-${i}",{opacity:1},${cue.start}).set("#vp-caption-cue-${i}",{opacity:0},${cue.end});`,
    );
    cue.words.forEach((word, wIdx) => {
      const id = cueWordIds[i]?.[wIdx];
      if (!id) return;
      timelineSteps.push(
        `tl.set("#${id}",{attr:{"data-active":"0"}},0).set("#${id}",{attr:{"data-active":"1"}},${word.start}).set("#${id}",{attr:{"data-active":"0"}},${word.end});`,
      );
    });
  });
  const script = `<script>(function(){var tl=(window.__timelines||{})[${JSON.stringify(root[1])}];if(!tl)return;${timelineSteps.join("")}})();</script>`;
  const style = `${STYLE_START}<style data-vp-caption-style="${preset}">${captionPresetCss(preset)}</style>${STYLE_END}`;
  const close = findRootClose(clean, root.index + root[0].length);
  if (close < 0) return clean;
  let out = clean.slice(0, close) + START + cueSpans.join("\n") + END + clean.slice(close);
  // Estilo no <head> (ou no topo quando não existe <head>).
  const headEnd = out.indexOf("</head>");
  out = headEnd >= 0
    ? out.slice(0, headEnd) + style + out.slice(headEnd)
    : style + out;
  const body = out.lastIndexOf("</body>");
  const block = `${START}${script}${END}`;
  return body < 0 ? out + block : out.slice(0, body) + block + out.slice(body);
}

function findRootClose(html: string, afterOpen: number): number {
  const tokens = /<\/?div\b[^>]*>/gi;
  tokens.lastIndex = afterOpen;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    if (match[0].startsWith("</")) depth--;
    else if (!match[0].endsWith("/>")) depth++;
    if (depth === 0) return match.index;
  }
  return -1;
}
