/**
 * hyperframesAnimation.ts — Vendored digest of the `hyperframes-animation` skill.
 *
 * NOTICE: Apache License 2.0 — see ./NOTICE.md.
 * Condensed from: SKILL.md + rules-index.md (the shared contract) +
 * blueprints-index.md (menu only). Bundled as a string constant because
 * Supabase Edge Functions have no runtime filesystem access (V4-3f.1 / C2).
 *
 * Consumed by composeSystemPrompt() for the VISUAL and BUILD steps.
 */

export const HYPERFRAMES_ANIMATION_SKILL = `
# HyperFrames Animation — motion contract (vendored digest)

GSAP is the default runtime. All motion runs on ONE paused, seek-safe,
deterministic GSAP timeline registered on window.__timelines. Pick 2-4
atomic motion rules per scene and glue them together on that single timeline.

## The contract — every animation assumes this
- ONE paused GSAP timeline (never autoplay, never a second timeline),
  registered on window.__timelines["<composition-id>"].
- Seek-safe BOTH directions: use fromTo with explicit from-states (correct at
  t=0 under seek; immediateRender: false when re-owning a target), absolute
  values only — never relative "+=" tweens; state must be readable as a pure
  function of timeline time, no mutable trackers.
- Deterministic: no Math.random(), no Date.now() — index-derived
  pseudo-random and baked schedules only; finite repeats, never repeat: -1.
- Animate transforms and paint-only properties — width/height/top/left tweens
  are forbidden (use scale/translate proxies, masks, or anchored expansion).
- Cap group staggers so an arrival reads as one beat (items × stagger ≤ ~0.5s).
- No CSS transition on animated elements; hint compositors with
  will-change: transform where many tweens run at once.
- Pre-calculated layout constants — never derive positions from
  getBoundingClientRect() at tween time; compute once at composition setup.
- Spatial motion uses GSAP transform aliases only (x, y, scale, rotation);
  non-spatial tweens may also use opacity/color/backgroundColor/borderRadius.

## Common atomic rules (compose 2-4 per scene)
- spring-pop-entrance: element arrives with scale 0 → 1, back.out overshoot,
  via fromTo (correct at t=0 under seek); stagger ≤ 500ms.
- waterfall-entry: staggered arrival cascade; binary 0→1 opacity via tl.set —
  never fade an arrival.
- kinetic-beat-slam: short phrases slam in on ONE shared beat array with
  distinct per-phrase entrances, then a locked finale.
- stat-bars-and-fills: growth bars (scaleY stagger), progress fill (scaleX),
  count-up numbers via onUpdate + Math.round + tabular-nums.
- svg-path-draw: stroke-dasharray/dashoffset draw; measure getTotalLength()
  at setup; rotate rings -90deg to start at 12 o'clock.
- ambient-glow-bloom: soft radial glow blooming behind a hero, bounded idle
  breathe, peak opacity ≤ ~0.45.
- depth-of-field-blur: tween filter: blur() on off-focus layers via a --dof
  variable while the focal element stays sharp.
- viewport-change: virtual camera by transforming a single .world wrapper
  (translate(x,y) scale(S)); counter-translate T = -offset × S.
- Scale-swap / crossfade for scene-to-scene transitions; reveals paced to the
  spoken line across the shot, never dumped at t=0.

## Scene blueprints (proven shot shapes)
A blueprint is a time-coded shot template with slots and one signature move.
Instantiate one per frame when the shape fits; otherwise compose from the
rules above. Menu by narrative role:
- Hook: kinetic-type-beats, typewriter-reveal, spatial-pan-stations,
  constellation-hub, ticker-takeover, dataviz-countup,
  zoom-out-workspace-reveal, fixed-anchor-cycle.
- Problem: kinetic-type-beats, spatial-pan-stations, dataviz-countup,
  overwhelm-surround.
- Product intro: kinetic-type-beats, logo-assemble-lockup, cursor-ui-demo,
  device-surface-showcase, video-text-pivot, titlecard-reveal.
- Key feature: grid-card-assemble, cursor-ui-demo, device-surface-showcase,
  comparison-split, agent-progress-theater, panel-edit-live-sync,
  camera-journey, transcript-scroll-artifact-reveal.
- Benefits: kinetic-type-beats, grid-card-assemble, titlecard-reveal,
  camera-journey, zoom-out-workspace-reveal, fixed-anchor-cycle.
- Social proof: constellation-hub, grid-card-assemble (logo wall),
  titlecard-reveal, dataviz-countup.
- CTA: kinetic-type-beats, logo-assemble-lockup, cta-morph-press,
  titlecard-reveal (monochrome end-card chain), constellation-hub.
- Brand outro: kinetic-type-beats, typewriter-reveal, logo-assemble-lockup,
  ticker-takeover, fixed-anchor-cycle.

If no blueprint fits the beat, compose freely from the atomic rules — still
pace reveals to the voiceover across the full shot duration.
`.trim();
