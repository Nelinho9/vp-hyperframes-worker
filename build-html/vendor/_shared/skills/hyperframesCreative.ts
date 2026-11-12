/**
 * hyperframesCreative.ts — Vendored digest of the `hyperframes-creative` skill.
 *
 * NOTICE: Apache License 2.0 — see ./NOTICE.md.
 * Condensed from: SKILL.md + references/story-spine.md. Bundled as a string
 * constant because Supabase Edge Functions have no runtime filesystem access
 * (V4-3f.1 / C2).
 *
 * Consumed by composeSystemPrompt() for the DESIGN and STORYBOARD steps.
 */

export const HYPERFRAMES_CREATIVE_SKILL = `
# HyperFrames Creative — brand & narrative direction (vendored digest)

Brand, pacing, style, narration, and composition direction for HyperFrames
videos. This digest is non-animation: motion specifics belong to the
HyperFrames Animation contract.

## Design spec handling
- If a design spec exists (frame.md), treat its tokens as brand truth:
  colors, fonts, spacing, tone, constraints. Frontmatter is normative,
  prose is context.
- Colors MUST come from the brand tokens — never invent palette colors.
- Fonts MUST match the brand or use close system fallbacks.
- Interpret the brief, generate real content: avoid lazy defaults (generic
  gradient purple, lorem-ish filler, emoji icons, web-page layouts). A video
  frame needs video-medium density — scale, depth, and foreground detail —
  not an empty webpage hero.
- Background/foreground layering: every frame should have a background layer
  (imagery/gradient/solid) and a foreground layer (subject/type/detail).

## Beat planning
- Plan beats and rhythm before writing content: each beat is one idea, paced
  to the narration (2-5s typical), with a clear role (hook, problem,
  solution/intro, proof/benefit, CTA, outro).
- Transition timing belongs to the beat plan; do not add scenes, narration,
  music, captions or transitions the brief does not call for.

## Story spine — value-first narrative doctrine
1. The hook speaks the viewer's language: the first beat answers "why should
   I care" in OUTCOME language — what the viewer gains, avoids, or finally
   understands. Subject-internal vocabulary is banned in the hook (no feature
   lists, no internal names). Numbers welcome only when they carry stakes.
2. Reverse iceberg — value before evidence: the value claim lands BY THE
   SECOND beat. Everything after is evidence in service of that claim.
   Implementation is the footnote of the story, not the spine.
3. The storyboard is a proposal, not a listing: every frame's job ("why")
   must trace back to the central message — a frame whose why cannot be
   traced to the message is a frame to cut, not to decorate.

## Structure guidance (Hook → Problem → Solution → Proof → CTA)
- Hook (1-3s): outcome-language pain or promise.
- Problem (2-5s): amplify the pain with recognizable specifics.
- Solution / product intro: the brand arrives as the resolution.
- Proof / benefits: evidence beats (features, stats, social proof).
- CTA + outro: one clear action, then brand lockup held to the final frame.
`.trim();
