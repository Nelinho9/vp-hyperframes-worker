/**
 * hyperframesCore.ts — Vendored digest of the `hyperframes-core` skill.
 *
 * NOTICE: Apache License 2.0 — see ./NOTICE.md.
 * Condensed from: SKILL.md + references/determinism-rules.md +
 * references/tracks-and-clips.md. Bundled as a string constant because
 * Supabase Edge Functions have no runtime filesystem access (V4-3f.1 / C2).
 *
 * Consumed by composeSystemPrompt() for the BUILD step.
 */

export const HYPERFRAMES_CORE_SKILL = `
# HyperFrames Core — composition contract (vendored digest)

HyperFrames renders video from HTML. The DOM declares timing with data-*
attributes, the animation runtime is seekable, and media playback is owned
by the framework. The renderer seeks compositions frame-by-frame: every
frame must be reproducible from its time value alone.

## Composition structure
- Standalone root: <div data-composition-id="main" data-start="0"
  data-width="1920" data-height="1080" data-duration="15"> placed DIRECTLY
  in <body> — never wrapped in <template> (that hides all content).
- The root MUST carry data-start="0" (lint: root_composition_missing_data_start)
  and an explicit sized box (width/height in px). Total render duration is
  fixed by the root data-duration.
- Scene containers fill the frame: width:100%; height:100%; box-sizing:border-box.
- Use padding, flex, grid and max-width for layout; position:absolute only
  for layers/decoratives, not as the default content-layout strategy.
- A full-screen background fill goes on a full-bleed CHILD
  (position:absolute; inset:0), never on the composition root — the
  renderer's frame compositing can drop the root's own background (black frame).

## Clips and tracks
- A clip is any element with data-start + data-duration (+ data-track-index).
  Author visual scenes as <div class="clip">.
- The framework OWNS .clip visibility and lifecycle: a clip is visible only
  inside its [data-start, data-start + data-duration) window. Do not stack
  multiple top-level scenes at the same moment, do not show/hide clips
  manually, and do not gsap.set() later-scene clips at page load.
- data-track-index is TEMPORAL, not visual: two clips on the same track must
  NOT overlap in time (lint rejects it). Visual layering uses CSS z-index.
- data-start is seconds from composition start. It may reference another
  clip id ("intro + 2") — referenced clips need a known duration.
- <video>/<audio> clips: add muted + playsinline to video; the framework
  owns playback and seeking at any nesting depth.
- Total duration = max(start + duration) across top-level clips; keep it
  consistent with the root data-duration.

## One paused timeline (seek-safe)
- Register EXACTLY ONE gsap.timeline({ paused: true }) synchronously at page
  load on window.__timelines["<composition-id>"] (key = root data-composition-id).
- Never call tl.play() for render-critical motion — the renderer seeks, it
  does not play.
- Never build timelines inside async/Promise/setTimeout/event handlers.
- Use tl.set(selector, vars, time) inside the timeline (at/after the clip's
  data-start) instead of gsap.set() for later scenes.

## Determinism (non-negotiable)
- No Date.now()/performance.now()/render-time clocks; no unseeded
  Math.random(); no render-time network fetches; no hover/scroll/pointer
  state; no infinite loops (repeat: -1). Finite repeat counts only:
  Math.max(0, Math.floor(duration / cycleDuration) - 1).
- Animate ONLY the visual-property allowlist: opacity, x, y, scale, rotation,
  color, backgroundColor, borderRadius, transforms. Never tween display, raw
  visibility, width, height, top or left (use scale/translate proxies).
- GSAP autoAlpha and zero-duration visibility sets at explicit timeline
  boundaries are allowed ONLY on non-clip elements or wrappers inside a clip.
- Never animate the same property on the same element from multiple timelines.
- Transformed elements must be block-level AND sized (transform on an inline
  span is a no-op). No <br> in body text — let text wrap via max-width.
- Every id must be unique across the assembled page.

## First-pass lint gotchas
- Never pair a CSS initial transform with a GSAP tween on the same property
  (lint: gsap_css_transform_conflict). Set the initial state inside the tween:
  gsap.fromTo(el, { x: -40 }, { x: 0 }).
- No CSS transition on animated elements — they interpolate independently of
  seek and flicker.
`.trim();
