/**
 * visualStep.ts — V4-2 Step 4: Frame Visual Design
 *
 * Doc: docs/video-engine/V4_02_SKILLS_PIPELINE.md §4.
 * Skills: hyperframes-animation (visual-design, motion-language, rules-index,
 *         blueprints-index).
 *
 * Input:  STORYBOARD.md, frame.md, audio_meta.json
 * Output: Enriched STORYBOARD.md (time-coded shot sequences per frame)
 * Gate:   zod schema — every frame has time-coded shots, handoff blocks.
 */
import { z } from 'zod';
import { composeSystemPrompt } from '../_shared/skills/mod.ts';
import { buildBrandIdentityBlock } from './designStep.ts';

// ─── Output schema ─────────────────────────────────────────────────────────

// V4-3g.1: LLMs often emit numbers as strings ("1", "0.5"). Coerce numeric
// strings before validation instead of failing the whole step (the failure
// then goes through the retry-with-feedback loop in _steps.ts).
const coercedNumber = <S extends z.ZodNumber>(schema: S) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    schema,
  );

const ShotItemSchema = z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      const desc = v.trim();
      return {
        time_start: 0,
        time_end: 0,
        description: desc.length >= 3 ? desc : 'Shot sequence',
        blueprint: 'hero-reveal',
        motion_rules: [],
      };
    }
    return v;
  },
  z.object({
    time_start: coercedNumber(z.number().min(0)).default(0),
    time_end: coercedNumber(z.number().min(0)).default(0),
    description: z.string().min(1).default('Shot sequence'),
    blueprint: z.string().default('hero-reveal'),
    motion_rules: z.array(z.string()).default([]),
  }),
);

const ShotSequenceSchema = z.object({
  frame_number: coercedNumber(z.number().int().min(1)),
  shots: z.array(ShotItemSchema).min(1),
  handoff_out: z.any().optional().transform((v) => v == null ? undefined : typeof v === 'string' ? v : JSON.stringify(v)), // element continuing to next frame
  handoff_in: z.any().optional().transform((v) => v == null ? undefined : typeof v === 'string' ? v : JSON.stringify(v)),  // element arriving from previous frame
});

function normalizeVisualOutput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (!obj.enriched_storyboard_md) {
    const fallback = obj.storyboard_md || obj.storyboard || obj.enriched_storyboard || obj.markdown || obj.storyboard_markdown;
    if (typeof fallback === 'string' && fallback.trim().length >= 20) {
      obj.enriched_storyboard_md = fallback.trim();
    }
  }
  return obj;
}

export const VisualOutputSchema = z.preprocess(
  normalizeVisualOutput,
  z.object({
    video_direction: z.string().min(10), // ## Video direction block
    frame_sequences: z.array(ShotSequenceSchema).min(1),
    enriched_storyboard_md: z.string().min(20), // STORYBOARD.md with visual design
  }).passthrough(),
);

export type VisualOutput = z.infer<typeof VisualOutputSchema>;

// ─── System prompt ─────────────────────────────────────────────────────────

/** Base role/task prompt. V4-3f.1: composeSystemPrompt() injects the
 * vendored hyperframes-animation skill digest (B1). */
export const VISUAL_BASE_PROMPT = `You are a visual director for a HyperFrames video project.
Your task is to enrich the storyboard with time-coded shot sequences and motion direction.

## Skills context (hyperframes-animation: visual-design, motion-language, rules-index)
- For each storyboard frame, define time-coded shot sequences paced to voiceover.
- Pick a blueprint per shot (from blueprints-index): hero-reveal, stat-hit,
  product-grid, testimonial-quote, end-card, etc.
- Apply motion rules (from rules-index): 2-4 atomic rules per shot, composed
  via GSAP timeline (seek-safe, deterministic).
- Add handoff blocks for elements continuing across frame boundaries
  (handoff_out → handoff_in between contiguous frames).
- Write a ## Video direction block describing the overall visual language.

## Output format (JSON)
Return a JSON object with:
- video_direction: overall visual language description (markdown)
- frame_sequences: array of { frame_number, shots: [{ time_start, time_end,
    description, blueprint, motion_rules: string[] }], handoff_out?, handoff_in? }
- enriched_storyboard_md: full STORYBOARD.md with visual design added

## CONCISE OUTPUT (mandatory — latency budget)
- video_direction: MAX 80 words. Style tokens only (palette feel from tokens
  — scheme + accent — pacing, easing family); no prose.
- Shot description: MAX 12 words, action only. Never narrative, never repeat
  the storyboard text.
- motion_rules: 2-4 SHORT rule names (e.g. "ease-out-scale", "stagger-fade");
  never sentences.
- enriched_storyboard_md: keep the input content VERBATIM and add ONLY ONE compact
  "### Shots" block per frame — bullet lines like
  "- 0-3s: hero-reveal — slow zoom, ease-out". No extra prose sections, no
  summaries, no duplicated content.
- Output NOTHING besides the JSON object: no comments, no explanations.

## Rules
- Every frame MUST have at least one time-coded shot.
- Shot durations MUST fit within the frame's duration (from storyboard).
- Motion rules must be seek-safe (no clocks, no unseeded random).
- Handoffs required when elements span frame boundaries.
- enriched_storyboard_md must be valid HyperFrames STORYBOARD format.
- enriched_storyboard_md MUST keep the frame headings EXACTLY as provided in
  the input storyboard — "## Frame <N>: <Title> (<duration>s)" — verbatim.
  The editor timeline parser depends on this syntax: never rename "Frame"
  to "Scene"/"Beat" and never move the duration out of the heading
  parentheses. Only ADD enrichment content inside each frame's section.
`;

/** Full system prompt = base + vendored hyperframes-animation skill digest. */
export const VISUAL_SYSTEM_PROMPT = composeSystemPrompt('visual', VISUAL_BASE_PROMPT);

// ─── User message builder ──────────────────────────────────────────────────

export function buildVisualUserMessage(
  brief: string,
  inputs: Record<string, string>,
): string {
  const storyboard = inputs['STORYBOARD.md'] ?? '(no storyboard)';
  const frameMd = inputs['frame.md'] ?? '(no design spec)';
  const audioMeta = inputs['audio_meta.json'] ?? '{}';
  // V5_29 Fase C (C4): tokens.json passa a input do visual (o enriquecimento
  // deixava de derivar da marca). Ausente → secção omitida (layout legado).
  const tokensJson = inputs['capture/extracted/tokens.json'];
  const identityBlock = tokensJson && tokensJson.trim() ? buildBrandIdentityBlock(tokensJson) : '';
  const brandSection = tokensJson && tokensJson.trim()
    ? `\n## Brand tokens (palette)\n${identityBlock ? `${identityBlock}\n` : ''}\`\`\`json\n${tokensJson}\n\`\`\`\n`
    : '';
  return `## Project brief
${brief}

## Design system (frame.md)
\`\`\`markdown
${frameMd}
\`\`\`
${brandSection}
## Storyboard
\`\`\`markdown
${storyboard}
\`\`\`

## Audio metadata
\`\`\`json
${audioMeta}
\`\`\`

Enrich the storyboard with time-coded shot sequences, motion direction,
and handoff blocks. Pick blueprints and motion rules for each shot.
Let the video_direction carry the palette feel from tokens (scheme + accent).
Keep every addition concise (bullets, ≤12 words per shot — no prose).`;
}

// ─── Artifact extractor ────────────────────────────────────────────────────

export function extractVisualArtifacts(output: VisualOutput): Record<string, string> {
  return {
    'STORYBOARD.md': output.enriched_storyboard_md,
  };
}
