/**
 * mediaUse.ts — Vendored digest of the `media-use` skill.
 *
 * NOTICE: Apache License 2.0 — see ./NOTICE.md.
 * Condensed from: SKILL.md (resolve verb + audio engine guidance). Bundled
 * as a string constant because Supabase Edge Functions have no runtime
 * filesystem access (V4-3f.1 / C2).
 *
 * Consumed by composeSystemPrompt() for the AUDIO step.
 */

export const MEDIA_USE_SKILL = `
# media-use — media direction (vendored digest)

The media OS for HyperFrames projects: resolve · generate · operate ·
remember. In this pipeline the audio step only PLANS media (metadata); the
actual resolution/rendering happens downstream. Produce plans that reference
concrete, resolvable media intents.

## Resolve — the one verb
Every media need resolves to one frozen asset + metadata via a single verb:

| Type    | Intent                                                        |
| ------- | ------------------------------------------------------------- |
| bgm     | background music (mood-matched instrumental track)            |
| sfx     | sound effects for transitions/emphasis (whoosh, impact, pop)  |
| image   | photos, backgrounds                                           |
| icon    | icons, symbols (transparent)                                  |
| logo    | official brand marks (never redrawn)                          |
| voice   | TTS voiceover voice                                           |

Reuse before resolving fresh; keep asset references stable across steps.

## Audio direction rules (voiceover, BGM, SFX, captions)
- Voiceover: derive narration from the locked script; produce word-level
  timings aligned to each storyboard frame (start/end per segment).
- Pacing: narration segments must sit inside their frame's time window;
  leave breathing room at frame boundaries (no narration glued to cuts).
- BGM: select mood from the storyboard's music_mood; duration must cover the
  full video; when narration is present duck BGM volume to 0.2-0.3.
- SFX: transition whooshes/impacts only where the storyboard has hard cuts
  or emphasis beats; keep them sparse (never more than one per beat).
- Captions: when enabled, caption text equals the narration text per segment,
  timed from word timings; style comes from the design spec (caption-skin).
- Total audio duration MUST equal the storyboard total duration.
`.trim();
