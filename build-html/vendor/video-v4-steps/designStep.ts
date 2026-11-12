/**
 * designStep.ts — V4-2 Step 2: Design System (frame.md + caption-skin)
 *
 * Doc: docs/video-engine/V4_02_SKILLS_PIPELINE.md §4.
 * Skills: hyperframes-creative (frame-presets, palettes, design-spec).
 *
 * Input:  capture/extracted/tokens.json (brand tokens from V3 capture)
 * Output: frame.md (design spec) + caption-skin.html
 * Gate:   zod schema — palette, typography, frame_preset fields required.
 *         caption_skin_html missing/invalid no LLM output é reparado
 *         deterministicamente (normalizeDesignOutput, console.warn explícito)
 *         antes da validação — falha terminal 422 só com o resto inválido.
 *         typography numérico (heading_weight etc.) é coercido para string
 *         (V5 bugfix 504: evita o retry LLM que estoura o teto de 150s).
 */
import { z } from 'zod';
import { composeSystemPrompt } from '../_shared/skills/mod.ts';

// ─── Output schema (validated after LLM call) ──────────────────────────────

/** Shape of the palette/typography objects as emitted by the LLM (pre-validation). */
type DesignParts = {
  palette?: Record<string, unknown>;
  typography?: Record<string, unknown>;
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

function safeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value) ? value : fallback;
}

function safeFont(value: unknown, fallback: string): string {
  // Strip characters that would break the inline style attribute.
  const font = typeof value === 'string' ? value.replace(/["'<>&]/g, '').trim() : '';
  return font.length > 0 ? font : fallback;
}

/**
 * Deterministic caption-skin fragment built from the design's own
 * palette/typography (or safe fallbacks). Used ONLY as a logged repair when
 * the LLM omits caption_skin_html — never as a silent substitute.
 */
export function buildDefaultCaptionSkinHtml(
  palette?: Record<string, unknown>,
  typography?: Record<string, unknown>,
): string {
  const text = safeHex(palette?.text, '#FFFFFF');
  const pill = safeHex(palette?.secondary, '#0F0F14');
  const accent = safeHex(palette?.accent, '#FFFFFF');
  const font = safeFont(typography?.body_font, 'Inter');
  return `<div class="caption-skin" style="position:absolute;inset-inline:0;bottom:6%;display:flex;justify-content:center;pointer-events:none;">
  <span class="caption-text" style="font-family:'${font}',sans-serif;font-size:28px;font-weight:600;color:${text};background:${pill}e6;padding:10px 20px;border-radius:10px;letter-spacing:0.01em;border-bottom:2px solid ${accent};"></span>
</div>`;
}

/**
 * V5 bugfix (504 IDLE_TIMEOUT no designer): modelos em JSON mode devolvem
 * typography.heading_weight como NUMBER (ex.: 700) e o schema exige string —
 * a validação falhava e o retry V4-3g.1 com feedback disparava uma 2.ª
 * chamada LLM que, somada à 1.ª, estourava o teto de 150s wall-clock da
 * plataforma (IDLE_TIMEOUT 504). Coerção determinística number→string em
 * TODOS os campos de typography, com console.warn explícito (nunca
 * silencioso — AGENTS.md §3.3; padrão repairBgmSelection S22).
 */
function coerceTypographyToStrings(
  typography: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...typography };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      console.warn(`[designStep] typography.${key} numérico no output do LLM — a coercer para string`);
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * V5 bugfix (localhost E2E): alguns modelos em modo JSON omitem
 * caption_skin_html (normalmente dobrando-o dentro de frame_md) e o retry com
 * feedback falha da mesma forma → 422 VALIDATION_FAILED terminal. O preprocess
 * repara deterministicamente a partir da paleta/tipografia do PRÓPRIO output,
 * com console.warn explícito (nunca silencioso — AGENTS.md §3.3).
 */
export function normalizeDesignOutput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  const parts = raw as DesignParts;
  // typography: coerção determinística number→string (heading_weight etc.)
  // ANTES da validação — evita o retry LLM que estoura o teto de 150s.
  if (typeof parts.typography === 'object' && parts.typography !== null) {
    out.typography = coerceTypographyToStrings(parts.typography);
  }
  const caption = out.caption_skin_html;
  const valid = typeof caption === 'string' && caption.trim().length >= 10;
  if (!valid) {
    console.warn(
      '[designStep] caption_skin_html ausente/inválido no output do LLM — a reparar deterministicamente a partir de palette/typography',
    );
    out.caption_skin_html = buildDefaultCaptionSkinHtml(parts.palette, parts.typography);
  }
  return out;
}

export const DesignOutputSchema = z.preprocess(
  normalizeDesignOutput,
  z.object({
    frame_preset: z.string().min(1),
    palette: z.object({
      primary: z.string().regex(HEX_RE),
      secondary: z.string().regex(HEX_RE),
      background: z.string().regex(HEX_RE),
      text: z.string().regex(HEX_RE),
      accent: z.string().regex(HEX_RE),
    }),
    typography: z.object({
      heading_font: z.string().min(1),
      body_font: z.string().min(1),
      heading_weight: z.string().optional(),
    }),
    frame_md: z.string().min(50), // full frame.md content
    caption_skin_html: z.string().min(10), // caption-skin.html content
  }).passthrough(),
);

export type DesignOutput = z.infer<typeof DesignOutputSchema>;

// ─── System prompt (skills inlined — concise) ──────────────────────────────

/** Base role/task prompt. V4-3f.1: kept separate so composeSystemPrompt()
 * can inject the vendored hyperframes-creative skill digest (B1). */
export const DESIGN_BASE_PROMPT = `You are a visual design director for a HyperFrames video project.
Your task is to create a design system (frame.md) for the video based on brand tokens.

## Skills context (hyperframes-creative)
- Choose a frame preset that matches the brand personality.
- Available presets: editorial, cinematic, bold-minimal, luxury, tech-clean, organic-warm.
- Remix the preset onto the brand's color palette (extract from tokens.json).
- Typography must reflect the brand: heading + body fonts from tokens or sensible fallback.
- Output a complete frame.md (HyperFrames design spec format) and a caption-skin.html.

## Output format (JSON)
Return a JSON object with:
- frame_preset: name of the chosen preset
- palette: { primary, secondary, background, text, accent } as hex colors
- typography: { heading_font, body_font, heading_weight? }
  heading_weight MUST be a JSON STRING (e.g. "700"), NEVER a number.
- frame_md: full content of the frame.md file (markdown)
- caption_skin_html: full content of the caption-skin.html file

## Brand fidelity (V5_29 — roles, not positions)
- The brand tokens carry semantic ROLES (primary, background, accent, text…).
  Use background for surfaces, text for copy, primary for the dominant brand
  voice, and accent sparingly (CTA highlights, key details — never full-bleed
  fills or whole-scene washes).
- Color scheme: when the tokens declare "colorScheme: dark", design dark
  surfaces with light text (and vice-versa for "light"). Never invert the
  brand scheme; when absent, follow the frame preset.
- Type scale: set H1/body sizes from tokens.fontSizes (h1/body) and weights
  from tokens.fontWeights; fall back to the frame preset scale when absent.
- Radius: apply tokens.borderRadius to cards/pills/buttons; CTA components
  follow tokens.buttonPrimary (background + textColor).

## Rules
- Colors MUST come from the brand tokens (not invented).
- Fonts MUST match the brand or use close system fallbacks.
- frame.md must include: palette section, typography section, layout grid, spacing scale.
- caption_skin_html is MANDATORY and must appear as its OWN top-level JSON key.
  Never omit it, never fold it into frame_md — they are two separate files.
  It must be a complete HTML fragment for caption overlays (>= 10 chars), e.g.:
  "<div class='caption-skin' style='...'><span class='caption-text' style='color:#FFFFFF;background:#0F0F14;'></span></div>"
`;

/** Full system prompt = base + vendored hyperframes-creative skill. */
export const DESIGN_SYSTEM_PROMPT = composeSystemPrompt('design', DESIGN_BASE_PROMPT);

// ─── User message builder ──────────────────────────────────────────────────

/** Cap for vision inputs on the design call (screenshot + top assets). */
export const MAX_DESIGN_VISION_IMAGES = 4;

/**
 * V5_29 Fase C (C2): honest `Brand identity (roles)` block parsed from
 * tokens.json — only lines with detected data are emitted (never invented).
 * Returns '' when nothing usable is present (caller omits the section).
 */
export function buildBrandIdentityBlock(tokensJson: string): string {
  let tokens: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(tokensJson ?? '');
    if (typeof parsed !== 'object' || parsed === null) return '';
    tokens = parsed as Record<string, unknown>;
  } catch {
    return '';
  }
  const lines: string[] = [];

  const colorsRaw = tokens.colors as Record<string, string> | string[] | undefined;
  const roleEntries: Array<[string, string]> = [];
  if (Array.isArray(colorsRaw)) {
    const order = ['primary', 'secondary', 'accent', 'background', 'text'];
    colorsRaw.slice(0, order.length).forEach((hex, i) => {
      if (typeof hex === 'string' && hex.trim()) roleEntries.push([order[i], hex.trim()]);
    });
  } else if (colorsRaw && typeof colorsRaw === 'object') {
    for (const [role, hex] of Object.entries(colorsRaw)) {
      if (typeof hex === 'string' && hex.trim()) roleEntries.push([role, hex.trim()]);
    }
  }
  if (roleEntries.length > 0) {
    const primary = roleEntries.find(([r]) => r === 'primary')?.[1];
    const background = roleEntries.find(([r]) => r === 'background')?.[1];
    const rest = roleEntries
      .filter(([r]) => r !== 'primary' && r !== 'background')
      .map(([r, hex]) => `${r} ${hex}`);
    lines.push(
      primary && background
        ? `Palette (roles): primary ${primary} on background ${background}${rest.length ? `, ${rest.join(', ')}` : ''}`
        : `Palette (roles): ${roleEntries.map(([r, hex]) => `${r} ${hex}`).join(', ')}`,
    );
  }

  if (tokens.colorScheme === 'light' || tokens.colorScheme === 'dark') {
    lines.push(`Color scheme: ${tokens.colorScheme}`);
  }

  const typography = (tokens.typography ?? {}) as Record<string, unknown>;
  const headingFont = typeof typography.heading_font === 'string' ? typography.heading_font : '';
  const bodyFont = typeof typography.body_font === 'string' ? typography.body_font : '';
  if (headingFont || bodyFont) {
    lines.push(`Type: ${headingFont || '?'} / ${bodyFont || '?'}`);
  }

  const fontSizes = (tokens.fontSizes ?? {}) as Record<string, unknown>;
  const h1 = typeof fontSizes.h1 === 'string' ? fontSizes.h1 : '';
  const bodySize = typeof fontSizes.body === 'string' ? fontSizes.body : '';
  if (h1 || bodySize) {
    const fontWeights = (tokens.fontWeights ?? {}) as Record<string, unknown>;
    const weightBits = Object.entries(fontWeights)
      .filter(([, w]) => (typeof w === 'string' && w.trim()) || (typeof w === 'number' && Number.isFinite(w)))
      .map(([k, w]) => `${k} ${w}`);
    lines.push(
      `Type scale: H1 ${h1 || '?'} / body ${bodySize || '?'}${weightBits.length ? ` (weights: ${weightBits.join(', ')})` : ''}`,
    );
  }

  if (typeof tokens.borderRadius === 'string' && tokens.borderRadius.trim()) {
    lines.push(`Radius: ${tokens.borderRadius.trim()}`);
  }

  const buttonPrimary = tokens.buttonPrimary as { background?: unknown; textColor?: unknown } | undefined;
  const ctaBg = typeof buttonPrimary?.background === 'string' && buttonPrimary.background.trim()
    ? buttonPrimary.background.trim()
    : '';
  const ctaText = typeof buttonPrimary?.textColor === 'string' && buttonPrimary.textColor.trim()
    ? buttonPrimary.textColor.trim()
    : '';
  if (ctaBg || ctaText) {
    lines.push(`CTA: ${ctaBg ? `background ${ctaBg}` : 'brand style'}${ctaText ? ` with text ${ctaText}` : ''}`);
  }

  if (typeof tokens.tone === 'string' && tokens.tone.trim()) {
    lines.push(`Tone: ${tokens.tone.trim()}`);
  }

  return lines.join('\n');
}

/**
 * V5_29 Fase C (C2): vision URLs for the design call — `screenshot_url` first
 * (the LLM SEES the brand), then top assets by input order. Capped
 * (default 4 images); best-effort — '' / unparseable input returns [] and the
 * step proceeds text-only, never failing.
 */
export function extractDesignVisionUrls(tokensJson: string, maxImages = MAX_DESIGN_VISION_IMAGES): string[] {
  if (!tokensJson || maxImages <= 0) return [];
  try {
    const parsed: unknown = JSON.parse(tokensJson);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const tokens = parsed as { screenshot_url?: unknown; assets?: unknown };
    const urls: string[] = [];
    if (typeof tokens.screenshot_url === 'string' && tokens.screenshot_url.trim()) {
      urls.push(tokens.screenshot_url.trim());
    }
    const assets = Array.isArray(tokens.assets) ? tokens.assets : [];
    for (const asset of assets) {
      if (urls.length >= maxImages) break;
      const url = (asset as { url?: unknown })?.url;
      if (typeof url === 'string' && url.trim() && !urls.includes(url.trim())) {
        urls.push(url.trim());
      }
    }
    return urls.slice(0, maxImages);
  } catch {
    return [];
  }
}

export function buildDesignUserMessage(
  brief: string,
  inputs: Record<string, string>,
): string {
  const tokens = inputs['capture/extracted/tokens.json'] ?? '{}';
  const identityBlock = buildBrandIdentityBlock(tokens);
  const identitySection = identityBlock
    ? `\n## Brand identity (roles)\n${identityBlock}\n`
    : '';
  return `## Project brief
${brief}
${identitySection}
## Brand tokens (from capture)
\`\`\`json
${tokens}
\`\`\`

Create the design system (frame.md + caption-skin.html) for this project.
Choose a frame preset that matches the brand personality, remix the palette
from the brand tokens, and produce the complete frame.md and caption-skin.html.`;
}

// ─── Artifact extractor ────────────────────────────────────────────────────

export function extractDesignArtifacts(output: DesignOutput): Record<string, string> {
  return {
    'frame.md': output.frame_md,
    'caption-skin.html': output.caption_skin_html,
  };
}
