/**
 * captionStyle.ts — F03.9: captions com cue bounds, texto escapado,
 * timing_source explícito e base responsiva por ratio.
 *
 * Sem fallback universal de 32px: cada ratio tem base própria.
 * Sem VO, exige semântica editorial aprovada (não transcrição).
 */

export type CaptionTimingSource = "acoustic" | "estimated";
export type VideoRatio = "16:9" | "9:16" | "1:1";

// ─── C04.1: presets visuais de legenda dinâmica ────────────────────────────

export type CaptionPreset = "hormozi" | "editorial" | "karaoke";

export const CAPTION_PRESETS: readonly CaptionPreset[] = ["hormozi", "editorial", "karaoke"] as const;

/** Omisso/inválido → `editorial` (aparência mais próxima do legado). */
export function normalizeCaptionPreset(value: unknown): CaptionPreset {
  return value === "hormozi" || value === "karaoke" || value === "editorial" ? value : "editorial";
}

/**
 * Tokens por cue por preset. `editorial` mantém frases curtas (6 palavras,
 * 2 linhas); `hormozi` destaca palavras com grupos mais curtos; `karaoke`
 * mantém grupos de 4 para a "pill" acompanhar a fala sem saltos largos.
 */
export function captionWordsPerCue(preset: CaptionPreset): number {
  if (preset === "hormozi") return 4;
  if (preset === "karaoke") return 4;
  return 6;
}

/**
 * CSS determinístico do preset. A palavra ativa é um `data-active="1"`
 * alternado pela timeline GSAP — nada de classes animadas por relógio
 * (seek-safe, render determinístico).
 */
export function captionPresetCss(preset: CaptionPreset): string {
  const base = [
    ".vp-word{display:inline-block;transition:none;will-change:transform,color;opacity:.62}",
    ".vp-word[data-active=\"1\"]{opacity:1}",
  ];
  if (preset === "hormozi") {
    base.push(
      ".vp-caption[data-preset=\"hormozi\"]{background:transparent;padding:0}",
      ".vp-word[data-active=\"1\"]{color:#FFD84D;transform:scale(1.08)}",
    );
  } else if (preset === "karaoke") {
    base.push(
      ".vp-caption[data-preset=\"karaoke\"]{background:transparent;padding:0}",
      ".vp-word{border-radius:10px;padding:0 4px}",
      ".vp-word[data-active=\"1\"]{color:#101018;background:#FFD84D;padding:0 6px}",
    );
  } else {
    base.push(
      ".vp-caption[data-preset=\"editorial\"]{background:#101018f2;padding:12px 20px}",
      ".vp-word[data-active=\"1\"]{color:#fff}",
    );
  }
  return base.join("");
}

export interface CaptionCue {
  text: string;
  start: number;
  end: number;
  timing_source: CaptionTimingSource;
}

export function captionBaseForRatio(ratio: VideoRatio | string): { fontPx: number; bottomPct: number } {
  if (ratio === "16:9") return { fontPx: 28, bottomPct: 6 };
  if (ratio === "1:1") return { fontPx: 30, bottomPct: 6 };
  return { fontPx: 36, bottomPct: 7 };
}

export function escapeCaptionText(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cue dentro dos bounds da cena e do projeto, texto não vazio. */
export function validateCaptionCues(args: {
  cues: CaptionCue[];
  sceneStart: number;
  sceneEnd: number;
  projectDuration: number;
}): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  args.cues.forEach((c, i) => {
    if (!c.text.trim()) failures.push(`cue ${i} texto vazio`);
    if (!(c.end > c.start)) failures.push(`cue ${i} janela inválida`);
    if (c.start < args.sceneStart - 0.001 || c.end > args.sceneEnd + 0.001) {
      failures.push(`cue ${i} fora dos bounds da cena [${args.sceneStart},${args.sceneEnd}]`);
    }
    if (c.start < 0 || c.end > args.projectDuration + 0.001) {
      failures.push(`cue ${i} fora do projeto (0–${args.projectDuration}s)`);
    }
    if (c.timing_source !== "acoustic" && c.timing_source !== "estimated") {
      failures.push(`cue ${i} timing_source inválido`);
    }
  });
  return { ok: failures.length === 0, failures };
}

/**
 * Sem VO, captions:on exige semântica editorial aprovada.
 * `hasVo` = existe narração materializada; `editorialApproved` = brief/captions
 * editoriais aprovadas (não transcrição de VO inexistente).
 */
export function requireEditorialWhenNoVo(args: {
  captions: string;
  hasVo: boolean;
  editorialApproved: boolean;
}): { ok: true } | { ok: false; code: string; detail: string } {
  if (args.captions !== "on") return { ok: true };
  if (args.hasVo) return { ok: true };
  if (args.editorialApproved) return { ok: true };
  return {
    ok: false,
    code: "CAPTIONS_EDITORIAL_REQUIRED",
    detail: "Captions:on sem VO exige semântica editorial aprovada (não transcrição). Aprova captions editoriais ou liga narration.",
  };
}
