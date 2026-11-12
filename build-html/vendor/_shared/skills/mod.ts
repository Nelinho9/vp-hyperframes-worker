/**
 * mod.ts — Skills vendor barrel + per-step system prompt composition (B1).
 *
 * V4-3f.1 (plan Video_Studio_Correction_V4-3f): the orchestrator LLM steps
 * previously used short hardcoded system prompts. composeSystemPrompt()
 * injects the REAL (vendored) HyperFrames skill content per step, so the
 * pipeline is genuinely skills-driven (P12).
 *
 * NOTICE: Apache License 2.0 — see ./NOTICE.md for skill provenance.
 *
 * Step → skills mapping:
 *   design     → hyperframes-creative
 *   storyboard → hyperframes-creative (story-spine) + animation blueprints
 *   audio      → media-use
 *   visual     → hyperframes-animation
 *   build      → hyperframes-core + hyperframes-animation
 *
 * Only the sections relevant to each step are injected (cost/latency guard).
 */
import { HYPERFRAMES_ANIMATION_SKILL } from './hyperframesAnimation.ts';
import { HYPERFRAMES_CORE_SKILL } from './hyperframesCore.ts';
import { HYPERFRAMES_CREATIVE_SKILL } from './hyperframesCreative.ts';
import { MEDIA_USE_SKILL } from './mediaUse.ts';

export {
  HYPERFRAMES_ANIMATION_SKILL,
  HYPERFRAMES_CORE_SKILL,
  HYPERFRAMES_CREATIVE_SKILL,
  MEDIA_USE_SKILL,
};

/** Pipeline steps that get skill-augmented system prompts. */
export type SkillStep = 'design' | 'storyboard' | 'audio' | 'visual' | 'build';

const SKILLS_BY_STEP: Record<SkillStep, string[]> = {
  design: [HYPERFRAMES_CREATIVE_SKILL],
  storyboard: [HYPERFRAMES_CREATIVE_SKILL, HYPERFRAMES_ANIMATION_SKILL],
  audio: [MEDIA_USE_SKILL],
  visual: [HYPERFRAMES_ANIMATION_SKILL],
  build: [HYPERFRAMES_CORE_SKILL, HYPERFRAMES_ANIMATION_SKILL],
};

/**
 * Compose the full system prompt for a pipeline step:
 * the step's base role/task prompt + the vendored skill digests relevant
 * to that step, separated by clear markers.
 *
 * Unknown steps return the base prompt unchanged (fail-open, so prompt
 * composition can never break the pipeline).
 */
export function composeSystemPrompt(step: string, basePrompt: string): string {
  const skills = SKILLS_BY_STEP[step as SkillStep];
  if (!skills || skills.length === 0) return basePrompt;
  const injected = skills
    .map((skill) => `<skill-knowledge>\n${skill}\n</skill-knowledge>`)
    .join('\n\n');
  return `${basePrompt}\n\n## Injected skill knowledge (authoritative)\n\n${injected}`;
}
