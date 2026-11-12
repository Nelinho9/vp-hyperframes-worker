/**
 * storyboardStep.ts — V4-2 Step 3: Storyboard + Script
 *
 * Doc: docs/video-engine/V4_02_SKILLS_PIPELINE.md §4.
 * Skills: product-launch-video (story-spine, storyboard-format, blueprints-index).
 *
 * Input:  capture/extracted/tokens.json, frame.md
 * Output: STORYBOARD.md (with asset_candidates per frame) + SCRIPT.md
 * Gate:   zod schema — frames array with asset_candidates, duration match.
 */
import { z } from 'zod';
import { collectBriefLanguageCorpus, detectBriefTextLanguage } from '../_shared/briefAuthoritative.ts';
import { composeSystemPrompt } from '../_shared/skills/mod.ts';

// ─── Output schema ─────────────────────────────────────────────────────────

const StoryboardFrameSchema = z.object({
  frame_number: z.number().int().min(1),
  title: z.string().min(1),
  duration_sec: z.number().positive(),
  description: z.string().min(5),
  asset_candidates: z.array(z.string()).default([]),
  blueprint: z.string().optional(),
  narration: z.string().optional(),
});

export const StoryboardOutputSchema = z.object({
  duration_sec: z.number().positive(),
  frames: z.array(StoryboardFrameSchema).min(1).max(15),
  music_mood: z.string().optional(),
  storyboard_md: z.string().min(20), // full STORYBOARD.md content
  script_md: z.string().nullable().optional(),  // SCRIPT.md content (when narration needed)
}).passthrough();

export type StoryboardOutput = z.infer<typeof StoryboardOutputSchema>;

// ─── System prompt ─────────────────────────────────────────────────────────

/** Base role/task prompt. V4-3f.1: composeSystemPrompt() injects the
 * vendored hyperframes-creative (story-spine) + animation blueprints (B1). */
export const STORYBOARD_BASE_PROMPT = `You are a story director for a HyperFrames video project.
Your task is to create a frame-by-frame storyboard from the brief and design system.

## Skills context (product-launch-video: story-spine, storyboard-format)
- Follow the story spine: Hook → Problem → Solution → Proof → CTA.
- Each frame must have asset_candidates referencing real assets from the capture.
- Duration per frame: 2-5 seconds (total matches brief length).
- Include blueprint suggestions per frame (from blueprints-index):
  hero-reveal, stat-hit, product-grid, testimonial, end-card, etc.
- When narration is needed, produce a SCRIPT.md with timed narration text.

## Output format (JSON)
Return a JSON object with:
- duration_sec: total video duration
- frames: array of { frame_number, title, duration_sec, description,
    asset_candidates: string[], blueprint?, narration? }
- music_mood: suggested BGM mood (e.g. "uplifting", "dramatic", "calm")
- storyboard_md: full STORYBOARD.md content
- script_md: full SCRIPT.md content (null if no narration)

## Rules
- asset_candidates MUST reference real assets from the capture (not invented).
- Asset budget (V5_29 brand fidelity): use at most ONE asset with
  role=background in the whole video (max 1 background asset per video).
  hero_clean_plate is ONLY for frame 1; logo is ONLY for the intro and the
  end-card. Prefer product_shot/lifestyle plates for supporting frames —
  never spread photographic backgrounds across every scene.
- Total frame durations MUST sum to duration_sec.
- Minimum 2 frames, maximum 12.
- Narration planning defaults: when the approved brief leaves scene timing
  open, prefer narration windows of at least 3.5s and coverage of at least 85%.
  Approved explicit scene count, order, durations and verbatim short narration
  override these planning defaults. For example, four explicitly requested
  3s scenes in a 12s video remain four 3s scenes, preserving their short phrases.
  Never extend the video or merge requested scenes to satisfy a default.
  Actual synthesized speech is measured afterwards; the server rejects real
  window overflow. A planning duration is not proof of acoustic fit.
- STORYBOARD.md must follow the HyperFrames storyboard format.
- Language (non-negotiable): ALL narration, on-screen text, titles,
  STORYBOARD.md and SCRIPT.md MUST be written in the Language stated in the
  user message ("## Language") — or, when absent, in the same language as the
  brief. Never mix languages; never default to English for a non-English brief.
- Narration length budget (non-negotiable — voice-fit gate): each frame's
  narration MUST be speakable inside its own duration. Rate depends on
  ## Language: PT ~9 characters per second (3s → max ~27 chars; 4.2s → max
  ~38 chars); other languages ~13 per second (3s → max ~40 chars). Shorter is
  always fine; longer fails the voice gate and the video ships mute.

## STORYBOARD.md format (MANDATORY — machine-parsed)
STORYBOARD.md MUST contain one section per frame, and each section heading
MUST use EXACTLY this syntax (the editor timeline parser depends on it):

## Frame <N>: <Title> (<duration>s)

Full example:

# Storyboard: Project Title

## Overview
- **Target Duration:** 15s (ILLUSTRATIVE EXAMPLE ONLY — the real target comes
  in the user message as "Target duration: {N}s" and MUST be used instead)
- **Pacing:** Cinematic

## Frame 1: The Hook (3s)
Opening shot description.
- **Blueprint:** hero-reveal
- **Assets:** logo.png

## Frame 2: The Problem (4s)
Pain point description.
- **Blueprint:** stat-hit
- **Assets:** dashboard.png

Heading rules:
- Start with "## Frame", followed by the frame number, a colon, the title,
  and the duration in seconds inside parentheses (e.g. "(3s)").
- Never rename "Frame" to "Scene"/"Beat"; never put the duration only in a
  bullet or table — it MUST be in the heading parentheses.
- Frame numbers are sequential starting at 1.

## Social copy contract (C02)
- Keep the machine-readable labels below in English; their VALUES must use
  the project language specified above. Preserve all copy verbatim.
- Hook: opening on-screen copy, when present.
- On-screen text: all other text actually displayed in the frame.
- CTA: closing call to action, when present.
- Narration: spoken words; also include them in timed SCRIPT.md.
- Visual direction: staging, camera and animation instructions, never copy.
- Put each label and its complete value on one bullet line. Do not leave
  displayed text in an unlabeled paragraph or hide it in a frame title.
- Omit absent copy labels; never invent text just to populate a label.
`;

/** Full system prompt = base + vendored creative/animation skill digests. */
export const STORYBOARD_SYSTEM_PROMPT = composeSystemPrompt('storyboard', STORYBOARD_BASE_PROMPT);

// ─── User message builder ──────────────────────────────────────────────────

/**
 * F12-voz: duração-alvo explícita (antes o LLM só via o exemplo 15s e
 * planeava sempre ~15s, ignorando briefs de 30s — o gate F04 chumbava depois).
 */
export function storyboardDurationSec(metadata: unknown): number {
  const eff = (metadata as { effective_config?: { duration_seconds?: unknown } } | null)?.effective_config;
  const raw = eff?.duration_seconds;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 5 && raw <= 120) return Math.round(raw);
  return 15;
}

/**
 * F12-qualificação: idioma efetivo do projeto (o storyboarder escrevia EN por
 * omissão mesmo com brief PT — o vídeo saía noutra língua sem gate que
 * travasse). Null = sem idioma declarado (a regra do system prompt manda
 * seguir o idioma do brief).
 *
 * F13.04: com UI=`auto` (sem língua explícita), deriva do brief/diálogo
 * (brief PT → `pt`, nunca `en` silencioso) — a mesma precedência do builder
 * do brief, para a linha `## Language:` ser explícita e casar com o
 * `Video language:` do brief.
 */
export function storyboardLanguage(metadata: unknown): string | null {
  const m = (metadata ?? {}) as {
    language?: unknown;
    requested_config?: { language?: unknown };
    resolved_brief?: { language?: unknown; voice_locale?: unknown } | string | null;
  };
  const explicit = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 35 && v.trim() !== 'auto'
      ? v.trim()
      : null;
  const direct = explicit(m.language) ?? explicit(m.requested_config?.language);
  if (direct) return direct;
  if (m.resolved_brief && typeof m.resolved_brief === 'object') {
    const rbLang = explicit(m.resolved_brief.language);
    if (rbLang) return rbLang;
    const loc = typeof m.resolved_brief.voice_locale === 'string' ? m.resolved_brief.voice_locale.trim() : '';
    if (loc && loc !== 'auto') {
      const base = loc.toLowerCase().split('-')[0].split('_')[0];
      if (base.length >= 2 && base.length <= 35) return base;
    }
  }
  const detected = detectBriefTextLanguage(collectBriefLanguageCorpus(
    (metadata ?? null) as unknown as Parameters<typeof collectBriefLanguageCorpus>[0],
  ));
  return detected;
}

export function buildStoryboardUserMessage(
  brief: string,
  inputs: Record<string, string>,
  durationSec = 15,
  language: string | null = null,
): string {
  const tokens = inputs['capture/extracted/tokens.json'] ?? '{}';
  const frameMd = inputs['frame.md'] ?? '(no design spec yet)';
  const target = Number.isFinite(durationSec) && durationSec >= 5 && durationSec <= 120
    ? Math.round(durationSec)
    : 15;
  const langLine = language
    ? `## Language: ${language} — ALL narration, titles, on-screen text, STORYBOARD.md and SCRIPT.md MUST be in ${language}.`
    : `## Language: same as the brief (never default to English for a non-English brief).`;
  return `## Project brief
${brief}

${langLine}

## Target duration: ${target}s — frame durations MUST sum to exactly ${target}s (this overrides any example).

## Brand tokens (roles)
\`\`\`json
${tokens}
\`\`\`

Budget: use at most ONE role=background asset in this video (max 1 background asset per video); hero_clean_plate ONLY frame 1; logo ONLY intro/end-card.

## Design system (frame.md)
\`\`\`markdown
${frameMd}
\`\`\`

Create the storyboard (STORYBOARD.md) and script (SCRIPT.md) for this project.
Follow the story spine: Hook → Problem → Solution → Proof → CTA.
Each frame must reference real assets from the capture.`;
}

// ─── Artifact extractor ────────────────────────────────────────────────────

export function extractStoryboardArtifacts(output: StoryboardOutput): Record<string, string> {
  const artifacts: Record<string, string> = {
    'STORYBOARD.md': output.storyboard_md,
    'SCRIPT.md': output.script_md ?? '', // Clear obsolete narration on silent retries.
  };
  if (output.script_md) {
    artifacts['SCRIPT.md'] = output.script_md;
  }
  return artifacts;
}
