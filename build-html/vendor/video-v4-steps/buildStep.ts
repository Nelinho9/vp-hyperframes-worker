/**
 * buildStep.ts — V4-3pre Build step with lint retry loop (pure logic, DI)
 *
 * Doc: docs/video-engine/V4_03_STUDIO_UX_REFINED.md §4 (V4-3pre).
 *
 * Flow:
 *   1. Read storyboard, frame.md, audio_meta from storage
 *   2. Call LLM (system=hyperframes-core, user=storyboard+frame.md) → HTML
 *   3. Run `hyperframes lint` on HTML
 *   4. If lint fails → send errors to LLM → retry (max 3)
 *   5. After lint passes → return HTML (worker handles check/snapshot/render)
 *   6. Fallback: if 3 retries fail → pre-validated template
 *
 * All collaborators are injected via BuildDeps for testability under vitest.
 */

import { composeSystemPrompt } from '../_shared/skills/mod.ts';
import { autoRepairComposition, repairHeadingInheritance, repairMotionTweens, repairT0Visibility, type StoryboardTimingFrame } from './edgeLint.ts';
import { injectAudioTracks, type VoiceFileEntryLike } from './audioInjection.ts';
import { injectCaptions, type CaptionSegment } from './captionInjection.ts';
import { type CanonicalizeMediaResult } from './mediaUrls.ts';

// ─── Constants ─────────────────────────────────────────────────────────────

export const MAX_BUILD_RETRIES = 3;

// ─── PerfLog (V5_16 follow-up — incidente CPU 2026-09-02) ─────────────
// O builder morreu com `CPU Time exceeded (2000ms)` — o teto de CPU POR
// REQUEST da Supabase (diferente do idle de 150s e do wall max_duration) —
// sem qualquer evidência de ONDE o CPU ardeu. O PerfLog é um buffer bounded
// de marcas de fase que o index.ts do builder imprime UMA vez no fim (sucesso
// OU falha): custo de instrumentação ≈ zero (sem I/O por fase).

export interface PerfLog {
  /** Marca o fim de uma fase: ms desde a marca anterior (ou criação). */
  mark(name: string, extra?: Record<string, string | number | boolean | null | undefined>): void;
  /** Linha única e estável para o log de produção. */
  line(): string;
}

export function createPerfLog(
  now: () => number = Date.now,
  opts: { maxEvents?: number } = {},
): PerfLog {
  const maxEvents = opts.maxEvents ?? 64;
  let last = now();
  const events: string[] = [];
  let dropped = 0;
  return {
    mark(name, extra) {
      const t = now();
      const ms = Math.max(0, Math.round(t - last));
      last = t;
      if (events.length >= maxEvents) {
        dropped += 1;
        return;
      }
      const parts: string[] = [];
      for (const [k, v] of Object.entries(extra ?? {})) {
        if (v === null || v === undefined) continue;
        parts.push(`${k}=${v}`);
      }
      events.push(parts.length ? `${name}=${ms}ms(${parts.join(',')})` : `${name}=${ms}ms`);
    },
    line() {
      return dropped > 0 ? `${events.join(' ')} dropped=${dropped}` : events.join(' ');
    },
  };
}

// ─── Pre-validated fallback template ───────────────────────────────────────
// Minimal HyperFrames composition that passes lint. Kept as the absolute
// last-resort template; since V4-3f.17 the pipeline prefers the storyboard-
// derived fallback (buildStoryboardFallbackHtml), which preserves every
// frame of the user's video instead of one generic scene.

export const FALLBACK_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@heygen/hyperframes@0.7.109/dist/hyperframes.min.js"></script>
<style>
@font-face { font-family: 'Playfair Display'; src: local('Playfair Display'); }
@font-face { font-family: 'Poppins'; src: local('Poppins'); }
</style>
</head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="15" data-width="1080" data-height="1920" style="position:relative;width:1080px;height:1920px;overflow:hidden;">
  <div id="scene-1" class="clip" data-start="0" data-duration="15" data-track-index="0" style="position:absolute;inset:0;width:1080px;height:1920px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;flex-direction:column;">
    <h1 id="scene-1-text-1" style="color:#c9a84c;font-size:72px;font-family:Playfair Display,serif;margin:0;">Your Brand</h1>
    <p id="scene-1-text-2" style="color:#f5f0e6;font-size:32px;font-family:Poppins,sans-serif;margin-top:16px;">Discover more</p>
  </div>
</div>
<script>
window.__timelines = window.__timelines || {};
window.__timelines["main"] = gsap.timeline({ paused: true });
window.__timelines["main"].fromTo("#scene-1-text-1", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" }, 0.2);
window.__timelines["main"].fromTo("#scene-1-text-2", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" }, 0.6);
</script>
</body>
</html>`;

// ─── Interfaces (injected for testability) ─────────────────────────────────

export interface BuildLLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BuildLLMResult {
  content: string;
  tokens: { input: number; output: number };
}

export interface BuildLLMClient {
  call(messages: BuildLLMMessage[]): Promise<BuildLLMResult>;
}

export interface LintResult {
  ok: boolean;
  errors: string;
  /**
   * V4-3f.17 (V4_3F_16_INCIDENT Fase 2): warning-level findings. They never
   * fail the lint, but the retry loop forwards them to the LLM so issues
   * like duplicate media / oversized files get corrected automatically.
   */
  warnings?: string;
}

export interface LintRunner {
  /** V4-04B: optional storyboard frames enable the duration-mismatch gate. */
  lint(html: string, storyboardFrames?: StoryboardTimingFrame[]): Promise<LintResult>;
}

export interface BuildStorage {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
}

export interface BuildDbAdapter {
  getProject(projectId: string): Promise<{ id: string; user_id: string; manifest: unknown } | null>;
  updateManifest(projectId: string, manifest: Record<string, unknown>): Promise<void>;
  deductCredits(userId: string, amount: number, reference: string): Promise<{ success: boolean }>;
}

export interface BuildDeps {
  db: BuildDbAdapter;
  storage: BuildStorage;
  llm: BuildLLMClient;
  lint: LintRunner;
  now?: () => number;
  id?: () => string;
}

export type BuildResult =
  | { ok: true; html: string; artifacts: string[]; tokens: { input: number; output: number }; retries: number; fallback?: boolean }
  | { ok: false; status: number; code: string; fallback: boolean };

// ─── System prompt (HyperFrames core skills summary) ───────────────────────

export const BUILD_BASE_PROMPT = `You are a HyperFrames composition builder. You generate valid HTML compositions
that pass \`hyperframes lint\` validation.

## HyperFrames Core Rules
- Every composition MUST have a root \`<div class="composition" data-composition-id="main">\`
  wrapper with \`data-start="0"\`, \`data-duration\`, \`data-width\` and \`data-height\` attributes,
  placed directly in <body> (no <template> wrapper).
- Dimensions MUST be expressed as numeric attributes on the root
  (\`data-width="..." data-height="..."\`) matching the requested canvas size — CSS width/height alone is NOT accepted.
- Each scene is a \`<div class="clip">\` with \`data-start\` and \`data-duration\` attributes.
  ANY element that carries \`data-start\`/\`data-duration\` MUST have \`class="clip"\`
  (except the composition root).
- When the user message contains a "Storyboard timing table (BINDING)", the
  data-start/data-duration of every scene MUST be copied EXACTLY from that
  table. NÃO alteres durações/start das cenas; a tabela é vinculativa —
  the timeline, the audio and the final MP4 are all cut to these timings.
- Include EXACTLY these two external script tags in <head> — no others:
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@heygen/hyperframes@0.7.109/dist/hyperframes.min.js"></script>
- NEVER add any other external resource: no cdn.tailwindcss.com script, no
  Google Fonts <link>, no icon/font/image CDNs in <script> or <link> tags.
  The renderer runs OFFLINE — external references are stripped before render
  and would either break the build or silently vanish from the final MP4.
- Style with inline style="…" attributes or a single <style> block in <head>.
  Do NOT use Tailwind utility classes: the Tailwind CDN runtime cannot load
  offline, so those classes render as unstyled layout in the final MP4.

## Typography and Readability Scale (Mandatory — parametrized by effective canvas)
- Video is rendered for mobile and high-resolution screens; text MUST be large and legible.
- F04-T04: exemplos parametrizados pelo canvas efetivo (nunca vertical-only fixo).
- For 1080x1920 (9:16) compositions:
  - Main titles / headings: font-size between 56px and 84px (minimum 48px).
  - Subtitles / CTAs / cards: font-size between 32px and 48px (minimum 28px).
  - Body / captions: font-size between 24px and 32px (minimum 22px).
  - NEVER use font-size < 20px on any visible text.
- For 1920x1080 (16:9) compositions:
  - Main titles / headings: font-size between 48px and 72px (minimum 40px).
  - Subtitles / CTAs / cards: font-size between 28px and 44px (minimum 24px).
  - Body / captions: font-size between 20px and 28px (minimum 18px).
- For 1080x1080 (1:1) compositions:
  - Main titles / headings: font-size between 52px and 76px (minimum 44px).
  - Subtitles / CTAs / cards: font-size between 30px and 46px (minimum 26px).
  - Body / captions: font-size between 22px and 30px (minimum 20px).
- A escala segue o canvas efetivo da secção "Canvas Dimensions" acima; trocar
  ratio sem trocar a escala falha o gate (expected/observed).
- Heading semantics: \`<h1>\`…\`<h6>\` carry a browser default font-size of 2em
  and DO NOT inherit the wrapper font-size. ALWAYS declare \`font-size\` and
  \`line-height\` inline on the heading itself (or set
  \`font-size:inherit;line-height:inherit;font-weight:inherit\`). A wrapper
  font-size of 78px does not make the h1 78px — it renders ~156px and overlaps
  the next text block, failing the check/content_overlap gate.
- Fonts (offline renderer — strict whitelist, enforced by lint): use ONLY these
  bundled families (no @font-face needed) — sans: Inter, Montserrat, Poppins;
  serif: Playfair Display, EB Garamond; mono: Space Mono, JetBrains Mono,
  IBM Plex Mono, Source Code Pro — or a generic family (system-ui, sans-serif,
  serif, monospace). Any other family (including Space Grotesk and brand fonts
  such as Berkeley Mono) FAILS lint unless declared with @font-face carrying a
  captured src: url('capture/assets/fonts/<family>.woff2') — a src: local(...)
  alone does NOT resolve it (the MP4 would silently fall back to a generic
  font). When the brand asks for a non-whitelisted font, substitute the closest
  whitelisted match (mono → Space Mono / JetBrains Mono / IBM Plex Mono;
  serif → Playfair Display / EB Garamond; sans → Inter / Montserrat / Poppins).
- High contrast: ensure text color strongly contrasts with the scene background.
  Large text needs >=3:1 and body text >=4.5:1 (WCAG AA). Never reuse a light
  cream/accent text color intended for a dark panel outside that panel — on a
  light paper background it must be a dark tone (e.g. the brand's dark green
  or terracotta). Verify every text/background pair before finishing.

## Mandatory skeleton (copy this structure exactly — parametrized by effective dims above)
\`\`\`html
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="<target>" data-width="<W>" data-height="<H>" style="position:relative;width:<W>px;height:<H>px;overflow:hidden;">
  <div id="scene-1" class="clip" data-start="0" data-duration="<from timing table>" data-track-index="0" style="position:absolute;inset:0;width:<W>px;height:<H>px;">
    <!-- scene content with stable ids: <h1 id="scene-1-text-1">, <img id="scene-1-img-1">, … -->
  </div>
  <!-- more scene-N clips, strictly sequenced -->
</div>
<script>
window.__timelines = window.__timelines || {};
window.__timelines["main"] = gsap.timeline({ paused: true });
window.__timelines["main"].fromTo("#element-id", { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "power2.out" }, 0.2);
</script>
</body>
\`\`\`
The \`window.__timelines\` registration is MANDATORY — a composition without it
fails lint and cannot be rendered.

## Timeline model — single, paused, seek-safe, deterministic
- The renderer SEEKS the composition frame-by-frame; there is no playback.
  Every frame must be reproducible from its time value alone.
- Register EXACTLY ONE \`gsap.timeline({ paused: true })\` synchronously at page
  load on \`window.__timelines["main"]\`. Never call \`.play()\`; never build
  timelines inside async/Promise/setTimeout/event handlers.
- Seek-safe tweens only: \`fromTo\` with explicit from-states, absolute values
  (never relative \`"+="\` tweens), no \`repeat: -1\`, no \`Math.random()\`,
  no \`Date.now()\`, no CSS \`transition\` on animated elements.
- Animate only transforms/paint properties (x, y, scale, rotation, opacity,
  color, backgroundColor). Never tween width/height/top/left/display/visibility.
- Never pair a CSS initial transform with a GSAP tween on the same property
  (use \`gsap.fromTo\` for the initial state instead).

## Text legibility over media (non-negotiable — V5.22 Fase H1)
- All text layers MUST have z-index strictly greater than any scrim/overlay/plate
  in the same scene. Set explicit z-index on both layers — never rely on DOM
  order alone.
- Any scrim behind text MUST cover the text box at >=80% opacity (>=85% over
  photographic plates). Caption bars MUST fill >=90% width and sit bottom-safe
  >=120px from the canvas bottom.
- Never keep a photographic plate as the only contrast mechanism — either swap
  the \`src\` or add a scrim that meets the rule above. The generic contrast
  rule does not excuse a missing scrim.
- Specializing the seek-safe rule above for opacity: all GSAP opacity tweens
  MUST use absolute \`fromTo(target, { opacity: 0 }, { opacity: 1, ... })\`;
  arrivals are binary 0→1 via \`tl.set\` — never relative \`"+="\`/\`"-="\`
  opacity tweens, never \`.to\`/\`.from\` alone for an arrival.
  NEVER fade an arrival and never use \`steps(1)\` tweens: element entrances use
  \`tl.set(target, { opacity: 1 }, <time>)\` (binary toggle, no tween); \`fromTo\`
  opacity tweens are reserved for deliberate cross-fades with \`overwrite: "auto"\`.
- Text and hook elements MUST be visible at t=0: keep \`opacity: 1\` in markup
  and animate entrances with transform only (x/y/scale). Never leave
  \`opacity: 0\` inline or in a \`from\` state without a visible-first-frame
  \`tl.set\` — a t≈0 sampler must never see an empty hook.

## Caption-safe zone (non-negotiable — layout gate content_overlap)
- The pipeline injects auto caption overlays AFTER your HTML: absolute,
  left/right 5%, bottom 6-7% of canvas height, z-index 100, up to ~200px tall
  on 9:16. They are NOT in your markup and you MUST NOT create your own
  subtitle/caption overlays (see rule below).
- Keep EVERY authored text element (titles, subtitles, pills, badges, CTAs,
  lower-thirds, cards) ENTIRELY within the top 80% of the canvas height:
  - 1080x1920 (9:16): nothing authored below y=1536 (bottom 384px reserved).
  - 1920x1080 (16:9): nothing authored below y=864 (bottom 216px reserved).
  - 1080x1080 (1:1): nothing authored below y=864 (bottom 216px reserved).
- Any authored text entering the reserved zone overlaps the injected captions
  and fails the content_overlap gate — the build is rejected, no MP4.

## Clips MUST NOT overlap (this is the #1 cause of broken previews)
- Clips on the same track MUST NOT overlap in time. Sequence scenes strictly:
  scene N+1 starts exactly when scene N ends (data-start = previous start + duration).
- The framework owns \`.clip\` visibility: a clip is visible ONLY inside its own
  [data-start, data-start + data-duration) window. NEVER stack multiple scenes
  visible at the same moment, never show/hide clips manually, and never
  \`gsap.set()\` later-scene clips at page load.
- Total duration = max(clip.start + clip.duration) across all top-level clips;
  keep it equal to the root \`data-duration\`.
- A full-screen background fill goes on a full-bleed CHILD
  (position:absolute; inset:0), never on the composition root itself.

## Stable element IDs (required — validated by lint)
- Every clip gets an id \`scene-N\` (N = frame number, 1-based).
- Every editable element gets a unique id in the STABLE scheme
  \`scene-N-{type}-K\`:
  - N = the number of the parent scene (the clip \`scene-N\` it lives in);
  - {type} ∈ text|img|video|audio;
  - K = 1-based counter PER TYPE within that scene (restarts each scene):
    first text of scene 1 → \`scene-1-text-1\`, second → \`scene-1-text-2\`;
    first image of scene 2 → \`scene-2-img-1\`.
  - When duplicating an element (copy-paste in the editor), append \`-copy-M\`
    (\`scene-1-text-1-copy-1\`).
  - IDs outside this scheme will fail \`hyperframes lint\` and break the
    editor's property controls.
- Any element without an id in this scheme cannot be selected or edited in the
  Studio UI.

## Real captured media (mandatory when provided)
- When the user message includes a "Real captured assets" section, those are
  real images/videos scraped from the brand's own website. You MUST use those
  exact URLs as the \`src\` of \`img-*\`/\`video-*\` elements in the matching
  scenes: \`hero_clean_plate\` → opening scene, \`product_shot\` → product/feature
  scenes, \`logo\` → intro and end card, \`lifestyle\`/\`background\` → supporting scenes.
- Only use an asset as a \`video-*\` element \`src\` if its URL is a direct MP4
  file (ends in \`.mp4\` and downloads as video/mp4). If a "video" URL points to
  a player page, YouTube, Vimeo, or any non-direct resource, treat it as an
  \`img-*\` fallback or omit it — never pass a player/playlist/HTML URL to
  \`<video src\`.
- Add \`crossorigin="anonymous"\` to every \`<video>\` and \`<audio>\` element
  that uses an external URL.
- Never invent image URLs and never hotlink stock/placeholder services
  (unsplash, picsum, placehold, etc.) when captured assets are available.
- Background budget (V5_29 brand fidelity):
  Only ONE background plate per video — use at most one "background"-role
  asset as a full-bleed photographic plate. Extra photographic plates MUST
  be swapped for flat brand surfaces (palette background) or omitted —
  never spread photographic backgrounds across every scene.
- Any photographic plate behind text REQUIRES a brand-tinted scrim: the
  scrim MUST be brand-tinted (derived from the brand palette with alpha —
  never plain white/grey) while still covering the text box at >=80% opacity
  (>=85% over photographic plates) per the legibility rule above.
- NEVER use favicon/icon URLs (favicon.ico, apple-touch-icon*.png,
  apple-icon*.png, android-chrome*.png, mstile-*.png, safari-pinned-tab.svg)
  as scene media — not even for the brand logo. Brand sites bot-protect these
  files (they return HTTP 403 HTML instead of image bytes) and the render
  worker downloads EVERY external <img>/<video>/<audio> src before rendering:
  a single 403 fails the WHOLE build job (worker answers 422
  MEDIA_VALIDATION_FAILED). For the logo use the captured \`logo\` asset URL
  from "Real captured assets", or omit the logo — enforced by lint
  (\`favicon_icon_hotlink\`).

## Complexity constraints (enforced by lint — violations trigger retries)
- Keep the composition UNDER 250 lines of HTML. If the storyboard needs more
  markup, compress styling into classes/inline shorthand.
- Every \`.clip\` MUST carry a numeric \`data-track-index\`, and each track
  holds at most 3 timed clips (hyperframes lint limit).
- When the video has MORE THAN 3 scenes, split it into sub-compositions
  (child compositions referenced via \`data-composition-src\`) instead of one
  monolithic file.
- Never duplicate media: each \`<img>\`/\`<video>\`/\`<audio>\` appears at most
  once per src + timing window.
- GSAP tweens animate ONLY transform/paint properties (x, y, scale, rotation,
  opacity, color, backgroundColor). \`left\`/\`top\`/\`width\`/\`height\` tweens are
  rejected — use \`x\`/\`y\`/\`scale\` instead.
`;

export function resolveDimensions(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio?.toLowerCase()) {
    case '16:9':
    case 'landscape':
    case 'horizontal':
      return { width: 1920, height: 1080 };
    case '1:1':
    case 'square':
      return { width: 1080, height: 1080 };
    case '4:5':
    case 'feed':
      return { width: 1080, height: 1350 };
    case '9:16':
    case 'portrait':
    case 'vertical':
    default:
      return { width: 1080, height: 1920 };
  }
}

/**
 * V5.22 follow-up H1.3: fallback explícito/traçado — envolve
 * `resolveDimensions` e regista quando o `aspect_ratio` cai no default
 * 1080×1920 (ausente ou irreconhecível). Proibido default silencioso novo:
 * quem chama com valor válido nunca faz log.
 */
export function resolveDimensionsTraced(
  aspectRatio?: string,
): { width: number; height: number; usedDefault: boolean } {
  const normalized = aspectRatio?.toLowerCase();
  const known = [
    '16:9', 'landscape', 'horizontal',
    '1:1', 'square',
    '4:5', 'feed',
    '9:16', 'portrait', 'vertical',
  ].includes(normalized ?? '');
  const dims = resolveDimensions(aspectRatio);
  const usedDefault = !known;
  if (usedDefault) {
    console.warn(
      `[buildStep] resolveDimensions: aspect_ratio ausente/inválido (${JSON.stringify(aspectRatio)}) — fallback explícito 1080x1920 (9:16)`,
    );
  }
  return { ...dims, usedDefault };
}

/**
 * F03.4: dimsSection AUTORITATIVA — root + cenas + CSS + metadata nas 3 ratios.
 * Menção no prompt ou data-width isolado NÃO conta: esta secção exige root
 * data-width/height + style width/height + clips style + metadata iguais ao
 * efectivo. Chamadores devem passar o ratio efectivo (nunca omitir silenciosamente).
 */
export function buildAuthoritativeDimsSection(aspectRatio: string | undefined): { section: string; width: number; height: number; ratio: string; usedDefault: boolean } {
  const traced = resolveDimensionsTraced(aspectRatio);
  const ratio = aspectRatio === '16:9' || aspectRatio === 'landscape' || aspectRatio === 'horizontal' ? '16:9' : aspectRatio === '1:1' || aspectRatio === 'square' ? '1:1' : '9:16';
  const section = `## Canvas Dimensions (Mandatory — must match in root, scenes, CSS and metadata)\n- Width: ${traced.width}px, Height: ${traced.height}px (Aspect Ratio: ${ratio})\n- Root: <div class="composition" data-composition-id="main" data-width="${traced.width}" data-height="${traced.height}" style="position:relative;width:${traced.width}px;height:${traced.height}px;overflow:hidden;">\n- Clips: style="position:absolute;inset:0;width:${traced.width}px;height:${traced.height}px;"\n- Metadata: width=${traced.width}, height=${traced.height}, ratio=${ratio} (must equal root)\n\n`;
  return { section, width: traced.width, height: traced.height, ratio, usedDefault: traced.usedDefault };
}

/** Full system prompt = base + vendored core/animation skill digests. */
export const BUILD_SYSTEM_PROMPT = `${composeSystemPrompt('build', BUILD_BASE_PROMPT)}

## Materialized audio and subtitles
Voice, music and subtitle overlays are injected deterministically after your HTML.
Do not create audio elements or subtitle/caption overlays. Do not copy signed
audio URLs or invent music files. Keep the main GSAP timeline available.

## Output
Before answering, verify this checklist (any failure = invalid output):
1. Root div has class="composition" AND data-composition-id="main".
2. Root div has numeric data-width and data-height attributes.
3. Every timed element (except the root) has class="clip".
4. window.__timelines["main"] is registered synchronously with a paused GSAP timeline.
5. Clips are strictly sequenced with no overlaps.
6. Only whitelisted font families (or generics) are used — any other family has @font-face with a captured woff2.
7. No favicon/icon hotlinks in <img>/<video>/<audio> src — only captured asset URLs or data: URIs.
8. Background budget respected — at most one background plate per video, every photographic plate behind text with a brand-tinted scrim.

Return ONLY the HTML document. No markdown fences, no explanations.`;

// ─── Build step runner ─────────────────────────────────────────────────────

/**
 * V4-3f.17 (Fase 3): deterministic repair chain applied to every LLM attempt
 * before lint — structural omissions (autoRepairComposition) plus the
 * mechanical left/top→x/y tween rewrite (repairMotionTweens) that eliminates
 * the gsap_non_transform_motion error class seen in the V4-3f.16 incident,
 * plus the visible-first-frame repair (repairT0Visibility, V5.22 H2) that
 * removes inline `opacity: 0` from `data-anim-in` text layers so a t≈0
 * sampler never photographs an empty hook.
 */
function repairBuildHtml(rawContent: string): string {
  return repairT0Visibility(
    repairMotionTweens(repairHeadingInheritance(autoRepairComposition(extractHtml(rawContent)))),
  );
}

/** Format the retry feedback message: errors first, warnings when present. */
function buildRetryMessage(lintResult: LintResult): string {
  const warnings = (lintResult.warnings ?? '').trim();
  const warningsSection = warnings
    ? `\n\nAlso address these lint warnings where possible (they degrade the render quality):\n${warnings}`
    : '';
  return `Fix these lint errors:\n${lintResult.errors}${warningsSection}`;
}

/**
 * Execute the build step: LLM → HTML → lint retry → validated HTML.
 *
 * On success: writes compositions/index.html to storage, marks step done.
 * On failure after all retries: uses FALLBACK_TEMPLATE, marks step done
 * (with fallback flag in result).
 */
export async function runBuildStep(
  deps: BuildDeps,
  projectId: string,
  inputs: {
    storyboardPath: string;
    frameMdPath: string;
    audioMetaPath: string;
    /** V4-3h: capture/extracted/tokens.json — real scraped assets for the prompt. */
    tokensPath?: string;
  },
): Promise<BuildResult> {
  const project = await deps.db.getProject(projectId);
  if (!project) return { ok: false, status: 404, code: 'NOT_FOUND', fallback: false };

  const manifest = project.manifest as Record<string, unknown> & {
    steps: Record<string, { status: string; artifacts: string[]; error?: string; fallback?: boolean; fallback_reason?: string; duration_seconds?: number }>;
    credits: { spent: number; by_step: Record<string, number> };
  };
  if (!manifest?.steps) return { ok: false, status: 400, code: 'INVALID_MANIFEST', fallback: false };

  // 1. Mark running
  manifest.steps.build = { status: 'running', artifacts: [], error: undefined };
  await deps.db.updateManifest(projectId, manifest);

  // 2. Deduct credits (build = 4cr, V4-2 table)
  const creditCost = 4;
  const ref = deps.id ? deps.id() : crypto.randomUUID();
  const deduct = await deps.db.deductCredits(project.user_id, creditCost, ref);
  if (!deduct.success) {
    manifest.steps.build = { status: 'failed', artifacts: [], error: 'INSUFFICIENT_CREDITS' };
    await deps.db.updateManifest(projectId, manifest);
    return { ok: false, status: 402, code: 'INSUFFICIENT_CREDITS', fallback: false };
  }

  try {
    // 3. Read input artifacts
    const storyboard = (await deps.storage.readText(inputs.storyboardPath)) ?? '(no storyboard)';
    const frameMd = (await deps.storage.readText(inputs.frameMdPath)) ?? '(no design spec)';
    const audioMeta = (await deps.storage.readText(inputs.audioMetaPath)) ?? '{}';
    // V4-3f.4 (B3): brief carries the Customize panel settings (format,
    // duration, type, audio toggles, voice, core message).
    const brief = typeof (manifest as Record<string, unknown>).brief === 'string'
      ? ((manifest as Record<string, unknown>).brief as string)
      : undefined;
    // V4-3h: real scraped media (tokens.json bridged from video_captures).
    const capturedAssets = inputs.tokensPath
      ? buildCapturedAssetsSection((await deps.storage.readText(inputs.tokensPath)) ?? '')
      : '';
    // V4-04B: binding timing frames — prompt table + lint duration gate.
    const timingFrames = parseStoryboardFrames(storyboard) as StoryboardTimingFrame[];

    // 4. Initial LLM call
    const userMessage = buildBuildUserMessage(storyboard, frameMd, audioMeta, brief, capturedAssets, timingFrames);
    let llmResult = await deps.llm.call([
      { role: 'system', content: BUILD_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ]);
    // V4-3f.7 + V4-3f.17: deterministically repair mechanical omissions
    // (missing data-composition-id / data-width / data-height / __timelines)
    // and layout-prop tweens (left/top → x/y) so the dispatched HTML passes
    // both the extended edge lint and the worker's real hyperframes lint.
    let html = repairBuildHtml(llmResult.content);
    let totalInputTokens = llmResult.tokens.input;
    let totalOutputTokens = llmResult.tokens.output;
    let retryCount = 0;

    // 5. Lint retry loop (max MAX_BUILD_RETRIES)
    for (let retry = 0; retry < MAX_BUILD_RETRIES; retry++) {
      const lintResult = await deps.lint.lint(html, timingFrames);
      if (lintResult.ok) {
        // Lint passed — write to storage and mark done
        return await finalizeBuild(
          deps, projectId, manifest, html,
          { input: totalInputTokens, output: totalOutputTokens },
          retryCount,
        );
      }
      retryCount = retry + 1;
      // Send lint errors (and warnings, V4-3f.17) to the LLM for correction
      const retryMessage = buildRetryMessage(lintResult);
      llmResult = await deps.llm.call([
        { role: 'system', content: BUILD_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
        { role: 'assistant', content: html },
        { role: 'user', content: retryMessage },
      ]);
      html = repairBuildHtml(llmResult.content);
      totalInputTokens += llmResult.tokens.input;
      totalOutputTokens += llmResult.tokens.output;
    }

    // 6. All retries exhausted — V4-3f.17 (Fase 3): build a safety fallback
    // from the REAL storyboard (one validated scene per frame) instead of
    // the old generic single-scene template, so the timeline/preview keep
    // the project structure even when the LLM quality gate fails.
    const fallbackHtml = buildStoryboardFallbackHtml(storyboard);
    const fallbackLint = await deps.lint.lint(fallbackHtml, timingFrames);
    // Storyboard fallback is generated to pass lint, but check anyway.
    if (!fallbackLint.ok) {
      // Even fallback failed — mark as failed (should never happen)
      manifest.steps.build = {
        status: 'failed', artifacts: [],
        error: `FALLBACK_LINT_FAILED: ${fallbackLint.errors.slice(0, 200)}`,
      };
      await deps.db.updateManifest(projectId, manifest);
      return { ok: false, status: 422, code: 'BUILD_LINT_FAILED', fallback: true };
    }

    return finalizeBuild(
      deps, projectId, manifest, fallbackHtml,
      { input: totalInputTokens, output: totalOutputTokens },
      retryCount, { fallback: true, fallbackReason: 'BUILD_LINT_FAILED' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    manifest.steps.build = {
      status: 'failed', artifacts: [],
      error: `BUILD_ERROR: ${msg.slice(0, 200)}`,
    };
    await deps.db.updateManifest(projectId, manifest);
    return { ok: false, status: 500, code: 'BUILD_ERROR', fallback: false };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** One parsed storyboard frame (number, title, timing). */
export interface StoryboardFrame {
  num: number;
  title: string;
  start: number;
  duration: number;
}

/**
 * V4-3f.17 (Fase 3): lenient frame extraction from STORYBOARD.md, used to
 * build the safety fallback composition. Supports the two formats the LLM
 * actually produces:
 *   - `## Frame 1: Hook (0-3s)`  — explicit time ranges
 *   - `## Frame 1: Hook (3s)`    — standalone durations (cumulative starts)
 * Returns [] when nothing parses (caller falls back to a generic scene).
 */
export function parseStoryboardFrames(md: string): StoryboardFrame[] {
  const source = md ?? '';
  if (!source.trim()) return [];
  const cleanTitle = (raw: string, num: number) => {
    const t = raw.replace(/[*_`#]/g, '').trim();
    return t || `Frame ${num}`;
  };
  const frames: StoryboardFrame[] = [];
  let m: RegExpExecArray | null;

  // Pattern A: explicit range — `Frame N: Title (0-3s)`.
  const rangeRe = /Frame[ \t]+(\d+)[ \t]*[:—–-]*[ \t]*([^\n(]*?)[ \t]*\([ \t]*(\d+(?:\.\d+)?)[ \t]*[-–—][ \t]*(\d+(?:\.\d+)?)[ \t]*s[ \t]*\)/gi;
  while ((m = rangeRe.exec(source)) !== null) {
    const num = parseInt(m[1], 10);
    const start = parseFloat(m[3]);
    const end = parseFloat(m[4]);
    frames.push({ num, title: cleanTitle(m[2], num), start, duration: Math.max(0.5, end - start) });
  }

  // Pattern B: standalone duration — `Frame N: Title (3s)` (cumulative).
  if (frames.length === 0) {
    const simpleRe = /Frame[ \t]+(\d+)[ \t]*[:—–-]*[ \t]*([^\n(]*?)[ \t]*\([ \t]*(\d+(?:\.\d+)?)[ \t]*s(?:ec(?:onds?)?)?[ \t]*\)/gi;
    let cursor = 0;
    while ((m = simpleRe.exec(source)) !== null) {
      const num = parseInt(m[1], 10);
      const duration = parseFloat(m[3]);
      frames.push({ num, title: cleanTitle(m[2], num), start: cursor, duration });
      cursor += duration;
    }
  }

  // Deduplicate by frame number, keep numeric order.
  const seen = new Set<number>();
  return frames
    .filter((f) => {
      if (seen.has(f.num)) return false;
      seen.add(f.num);
      return true;
    })
    .sort((a, b) => a.num - b.num);
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * V4-3f.17 (Fase 3): intelligent fallback — a deterministic, pre-validated
 * HyperFrames composition built from the REAL storyboard (one scene per
 * frame, titles preserved, timing honored). Replaces the old generic
 * single-scene FALLBACK_TEMPLATE so a failed LLM build never silently
 * discards the user's video structure.
 *
 * Generated markup passes both the extended edge lint and the worker's real
 * hyperframes lint (root attrs, clip class, data-track-index, both runtime
 * scripts, paused timeline registry, transform-only tweens, no font families).
 */
export function buildStoryboardFallbackHtml(storyboardMd: string, aspectRatio?: string): string {
  // V5.22 follow-up H1.3: fallback traçado (nunca silencioso).
  const dims = resolveDimensionsTraced(aspectRatio);
  const parsed = parseStoryboardFrames(storyboardMd);
  const frames: StoryboardFrame[] = parsed.length > 0
    ? parsed
    : [{ num: 1, title: 'Your Brand', start: 0, duration: 15 }];
  const total = frames.reduce((acc, f) => Math.max(acc, f.start + f.duration), 0);

  const clips = frames
    .map((f) => `  <div id="scene-${f.num}" class="clip" data-start="${f.start}" data-duration="${f.duration}" data-track-index="0" style="position:absolute;inset:0;width:${dims.width}px;height:${dims.height}px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;">
    <h2 id="scene-${f.num}-text-1" style="color:#f5f0e6;font-size:${dims.width === 1080 && dims.height === 1920 ? 64 : 56}px;margin:0;text-align:center;">${escapeHtmlText(f.title)}</h2>
  </div>`)
    .join('\n');

  const tweens = frames
    .map((f) => `window.__timelines["main"].fromTo("#scene-${f.num}-text-1", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, ${f.start + 0.2});`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Video</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@heygen/hyperframes@0.7.109/dist/hyperframes.min.js"></script>
</head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${dims.width}" data-height="${dims.height}" style="position:relative;width:${dims.width}px;height:${dims.height}px;overflow:hidden;">
${clips}
</div>
<script>
window.__timelines = window.__timelines || {};
window.__timelines["main"] = gsap.timeline({ paused: true });
${tweens}
</script>
</body>
</html>`;
}

/**
 * V4-04B §2.4: sum of `.clip` data-duration values in a composition HTML —
 * the real total duration used for manifest telemetry and divergence
 * checks. Returns 0 when no clips parse.
 */
export function sumClipDurationsSec(html: string): number {
  if (typeof html !== 'string' || !html) return 0;
  let total = 0;
  const tagRe = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\bclass\s*=\s*"[^"]*\bclip\b[^"]*"/i.test(tag)) continue;
    if (/\bdata-composition-id\s*=/i.test(tag)) continue; // composition root
    const dur = parseFloat(tag.match(/\bdata-duration\s*=\s*"([^"]*)"/i)?.[1] ?? '');
    if (Number.isFinite(dur) && dur > 0) total += dur;
  }
  return Math.round(total * 100) / 100;
}

async function finalizeBuild(
  deps: BuildDeps,
  projectId: string,
  manifest: Record<string, unknown> & {
    steps: Record<string, { status: string; artifacts: string[]; error?: string; fallback?: boolean; fallback_reason?: string; duration_seconds?: number }>;
    credits: { spent: number; by_step: Record<string, number> };
  },
  html: string,
  tokens: { input: number; output: number },
  retries: number,
  fallbackFlags?: { fallback: boolean; fallbackReason: string },
): Promise<BuildResult> {
  const artifactPath = `projects/${projectId}/compositions/index.html`;
  await deps.storage.writeText(artifactPath, html);

  const creditCost = 4;
  // V4-3f.17 (Fase 3): transparency flags — the step stays `done` (the
  // pipeline never blocks), but the manifest records that the composition is
  // a safety fallback so the Studio UI can warn the user and offer retry.
  // V4-04B §2.4: duration telemetry — the real composition duration is
  // recorded on the step so the UI/audio can detect divergence.
  manifest.steps.build = {
    status: 'done',
    artifacts: ['compositions/index.html'],
    duration_seconds: sumClipDurationsSec(html),
    ...(fallbackFlags?.fallback
      ? { fallback: true, fallback_reason: fallbackFlags.fallbackReason }
      : {}),
  };
  manifest.credits.spent += creditCost;
  manifest.credits.by_step.build = (manifest.credits.by_step.build ?? 0) + creditCost;
  await deps.db.updateManifest(projectId, manifest);

  return {
    ok: true,
    html,
    artifacts: ['compositions/index.html'],
    tokens,
    retries,
    ...(fallbackFlags?.fallback ? { fallback: true } : {}),
  };
}

/**
 * V4-3h: compact "real captured assets" section for the build prompt, parsed
 * from capture/extracted/tokens.json (bridged from the V3 video-capture row).
 * Lists the scraped media (signed storage URLs + role + caption) so the agent
 * builds the composition with the brand's REAL imagery instead of inventing
 * or hotlinking placeholders. Returns '' when there is nothing usable.
 */
export function buildCapturedAssetsSection(tokensJson: string): string {
  try {
    const tokens = JSON.parse(tokensJson) as {
      assets?: Array<{ url?: string; role?: string; caption?: string }>;
      screenshot_url?: string;
    };
    const assets = Array.isArray(tokens?.assets) ? tokens.assets : [];
    let index = 0;
    const lines = assets
      .filter((a) => typeof a?.url === 'string' && Boolean(a.url))
      .slice(0, 12)
      .map((a) => {
        index += 1;
        const label = captureAssetLabel(a.url as string, index);
        return `- [${a.role ?? 'asset'}] ${a.url}${a.caption ? ` — ${a.caption}` : ''} (${label})`;
      });
    if (typeof tokens?.screenshot_url === 'string' && tokens.screenshot_url) {
      lines.push(`- [website_screenshot] ${tokens.screenshot_url} (${captureAssetLabel(tokens.screenshot_url, index + 1)})`);
    }
    if (lines.length === 0) return '';
    // V5_32 Fase A (A5): redução de erros (a garantia é a canonicalização A2).
    lines.push(
      '- Signed URLs are re-signed on the server before render: copy each URL EXACTLY as given and NEVER reuse another asset\'s URL or token (never pair e.g. asset-4\'s token with asset-5\'s path).',
    );
    return `## Real captured assets (scraped from the brand's website — use these exact URLs for img-*/video-* src)\n${lines.join('\n')}\n\n`;
  } catch {
    return '';
  }
}

/**
 * V5_32 Fase A (A5): rótulo curto e estável de um asset para o prompt (o
 * basename sem extensão — `asset-4`, `logo`, `full`). Mantém-se legível mesmo
 * com URLs assinadas enormes e deixa o LLM distinguir linhas quase idênticas.
 */
function captureAssetLabel(url: string, index: number): string {
  const path = url.split(/[?#]/, 1)[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  const withoutExt = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  return withoutExt || `asset-${index}`;
}

/**
 * V4-04B §2.3: explicit BINDING timing table derived from the parsed
 * storyboard frames. The build prompt instructs the LLM to copy these
 * data-start/data-duration values verbatim — the #1 defense against the
 * "timeline 30s vs render 18s" incident class.
 */
export function buildStoryboardTimingTable(frames: StoryboardTimingFrame[]): string {
  if (!Array.isArray(frames) || frames.length === 0) return '';
  const rows = frames
    .map((f) => `scene-${f.num}: start=${f.start} duration=${f.duration}s`)
    .join('\n');
  return `## Storyboard timing table (BINDING — copy data-start/data-duration EXACTLY)\n${rows}\n\n`;
}

/**
 * Build the user message for the build LLM call.
 * Combines storyboard, frame.md, and audio metadata into a single prompt.
 * V4-3f.4 (B3): when a project brief is available (manifest.brief, which
 * carries the Customize panel settings — format/duration/type/audio/voice),
 * it is prepended so the composition honors the user's video settings.
 * V4-3h: when captured assets are available (from the scrape bridge), they
 * are included so the composition uses real brand media.
 * V4-04B: the binding storyboard timing table is injected so scene timings
 * in the generated HTML match the storyboard frame-by-frame.
 */
export interface EffectiveBuildDims {
  width: number;
  height: number;
  ratio: string;
  fps?: number;
  duration_target_seconds?: number;
}

export function buildBuildUserMessage(
  storyboard: string,
  frameMd: string,
  audioMeta: string,
  brief?: string,
  capturedAssets?: string,
  timingFrames?: StoryboardTimingFrame[],
  aspectRatio?: string,
  effective?: EffectiveBuildDims | null,
): string {
  // F04-T04: width/height/fps/duration efetivos no prompt e no validator.
  // Quando effective presente, ele vence (valores numéricos + igualdade ao
  // effective config); senão legacy aspectRatio com fallback explícito.
  const effRatio = effective && typeof effective.ratio === 'string' ? effective.ratio : (aspectRatio ?? '9:16');
  const dimsAuth = effective && Number.isFinite(effective.width) && Number.isFinite(effective.height)
    ? (() => {
      const ratio = effRatio === '16:9' || effRatio === 'landscape' ? '16:9' : effRatio === '1:1' || effRatio === 'square' ? '1:1' : '9:16';
      const section = `## Canvas Dimensions (Mandatory — must match in root, scenes, CSS and metadata)\n- Width: ${effective.width}px, Height: ${effective.height}px (Aspect Ratio: ${ratio})\n- Root: <div class="composition" data-composition-id="main" data-width="${effective.width}" data-height="${effective.height}" style="position:relative;width:${effective.width}px;height:${effective.height}px;overflow:hidden;">\n- Clips: style="position:absolute;inset:0;width:${effective.width}px;height:${effective.height}px;"\n- Metadata: width=${effective.width}, height=${effective.height}, ratio=${ratio} (must equal root)\n\n`;
      return { section, width: effective.width, height: effective.height, ratio, usedDefault: false };
    })()
    : buildAuthoritativeDimsSection(effRatio);
  const dimsSection = dimsAuth.section;
  const fpsDurSection = effective && (typeof effective.fps === 'number' || typeof effective.duration_target_seconds === 'number')
    ? `## Effective timing (Mandatory — must match root and clips)\n- FPS: ${typeof effective.fps === 'number' ? effective.fps : 30} (staging e render usam a mesma effective fps; 30 salvo capacidades aprovadas F03)\n- Duration target: ${typeof effective.duration_target_seconds === 'number' ? effective.duration_target_seconds : '(ver timing table)'}s (root data-duration e max(start+duration) iguais; nunca soma de overlaps)\n\n`
    : '';

  const briefSection = brief && brief.trim()
    ? `## Project brief (user settings are mandatory)\n${brief.trim()}\n\n`
    : '';
  const assetsSection = capturedAssets && capturedAssets.trim() ? capturedAssets : '';
  const timingSection = timingFrames && timingFrames.length > 0
    ? buildStoryboardTimingTable(timingFrames)
    : '';
  return `${dimsSection}${fpsDurSection}${briefSection}${assetsSection}${timingSection}## Storyboard
\`\`\`markdown
${storyboard}
\`\`\`

## Design spec (frame.md)
\`\`\`markdown
${frameMd}
\`\`\`

## Audio metadata
\`\`\`json
${audioMeta}
\`\`\`

Generate a valid HyperFrames HTML composition for this video project.
The composition must include all frames from the storyboard as clips
with correct data-start and data-duration attributes${
    timingSection
      ? ' — copied EXACTLY from the binding timing table above'
      : ''
  }.`;
}

/**
 * V5-P5A §2.2 / V5-P5B §2.3: injeta as tracks de áudio determinísticas
 * (`<audio data-track="vo">` da voz TTS real + `<audio data-track="bgm">`
 * do catálogo com volume/fades) no HTML validado.
 * BEST-EFFORT: sem signRead/resolveBgmSrc, meta sem files/bgm, ou falha de
 * assinatura ⇒ o build segue MUDO com log honesto (nunca bloqueia).
 */
async function injectVoTracks(
  html: string,
  metaJson: string,
  io?: {
    signRead?: (path: string) => Promise<string | null>;
    resolveBgmSrc?: (file: string) => string | null;
  },
): Promise<string> {
  let files: VoiceFileEntryLike[] = [];
  let bgmMeta: { path?: unknown; volume?: unknown; duration_sec?: unknown } | null = null;
  let captionMeta: {
    captions_enabled?: boolean;
    narration_segments?: CaptionSegment[];
    timing_source?: 'acoustic' | 'estimated';
    caption_style?: string;
  } = {};
  try {
    const meta = JSON.parse(metaJson ?? '{}') as {
      files?: VoiceFileEntryLike[];
      bgm?: { path?: unknown; volume?: unknown; duration_sec?: unknown } | null;
      captions_enabled?: boolean;
      narration_segments?: CaptionSegment[];
      timing_source?: 'acoustic' | 'estimated';
      caption_style?: string;
    };
    files = Array.isArray(meta?.files) ? meta.files : [];
    captionMeta = meta;
    if (meta?.bgm && typeof meta.bgm === 'object') bgmMeta = meta.bgm;
  } catch {
    return html;
  }

  // ── VO (P5A): assina cada ficheiro ok
  const urlByPath = new Map<string, string>();
  const okFiles = files.filter((f) => f && f.status === 'ok' && typeof f.path === 'string');
  if (okFiles.length > 0 && io?.signRead) {
    for (const f of okFiles) {
      try {
        const signed = await io.signRead(f.path as string);
        if (signed) urlByPath.set(f.path as string, signed);
        else console.error(`[build] audio track skipped (signRead null): ${f.path}`);
      } catch (err) {
        console.error(`[build] audio track signRead failed: ${f.path}`, err);
      }
    }
  }

  // ── BGM (P5B): src pública na biblioteca vendida do worker
  let bgmOpts: { src: string; volume?: number; durationSec?: number } | null = null;
  if (bgmMeta && typeof bgmMeta.path === 'string') {
    try {
      const generated = /^projects\/[^/]+\/audio\/music\/[a-f0-9]{64}\/bgm\.(mp3|wav)$/.test(bgmMeta.path);
      const src = generated ? await io?.signRead?.(bgmMeta.path) : io?.resolveBgmSrc?.(bgmMeta.path);
      if (generated && !src) throw new Error('MUSIC_STORAGE_SIGN_FAILED');
      if (src) {
        const bgmDurationSec = Number(bgmMeta.duration_sec);
        bgmOpts = {
          src,
          volume: typeof bgmMeta.volume === 'number' ? bgmMeta.volume : undefined,
          // Faixa real mais curta que a root: a janela BGM é clampada no build.
          durationSec: Number.isFinite(bgmDurationSec) && bgmDurationSec > 0 ? bgmDurationSec : undefined,
        };
      } else {
        console.error(`[build] BGM injection skipped (resolveBgmSrc null): ${bgmMeta.path}`);
      }
    } catch (err) {
      if (/^projects\//.test(String(bgmMeta.path))) throw err;
      console.error('[build] BGM resolveBgmSrc failed:', err);
    }
  }

  if (urlByPath.size === 0 && !bgmOpts) {
    return injectCaptions(html, captionMeta);
  }

  const result = injectAudioTracks(html, {
    files: okFiles.filter((f) => urlByPath.has(f.path as string)),
    resolveSrc: (p) => urlByPath.get(p) ?? null,
    bgm: bgmOpts,
  });
  if (result.injected > 0 || result.bgmInjected) {
    console.log(`[build] injected audio tracks: vo=${result.injected} bgm=${result.bgmInjected}`);
  } else {
    console.error('[build] audio injection produced 0 tracks (no matching scenes/root?)');
  }
  return injectCaptions(result.html, captionMeta);
}

/**
 * Extract HTML from LLM response (strip markdown fences if present).
 * Also handles JSON wrapper {title, duration, html} — extracts the html field.
 */
export function extractHtml(content: string): string {
  let trimmed = content.trim();
  // Strip ```html ... ``` or ``` ... ``` fences
  const fenceMatch = trimmed.match(/^```(?:html)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) trimmed = fenceMatch[1].trim();
  // Handle JSON wrapper: {title, duration, html}
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.html === 'string') {
        return parsed.html.trim();
      }
    } catch {
      // Not valid JSON — use as-is
    }
  }
  return trimmed;
}

// ─── Orchestrator bridge ────────────────────────────────────────────────────

/**
 * V5_26 (incidente CPU 2026-09-10): UMA tentativa de build — LLM + repair +
 * lint, nada mais. É a unidade de invocação do self-chain do builder: a edge
 * `video-v4-builder` executa exatamente uma por request e o loop de retries
 * vive no orquestrador (cada retry = novo request = novo orçamento de 2s de
 * CPU da plataforma — teto documentado em STATE_CURRENT §26.1, cuja solução
 * estrutural era "partir o build em invocações de 1 tentativa").
 *
 * Outcomes:
 *  - `success`  — lint passou; o HTML já leva as faixas de áudio injetadas;
 *  - `retry`    — lint falhou e há tentativas restantes: `attemptHtml` é o
 *                 HTML pós-repair (a mensagem `assistant` da chamada seguinte)
 *                 e `lint` leva os erros/warnings para o feedback;
 *  - `fallback` — última tentativa (attempt === MAX_BUILD_RETRIES) falhou:
 *                 fallback derivado do storyboard (V4-3f.17) com áudio
 *                 injetado, SEM nova chamada LLM.
 */
export type BuildAttemptResult =
  | { ok: true; kind: 'success'; html: string; tokens: { input: number; output: number }; durationSeconds: number }
  | {
      ok: true;
      kind: 'retry';
      attemptHtml: string;
      lint: { errors: string; warnings: string };
      tokens: { input: number; output: number };
    }
  | {
      ok: true;
      kind: 'fallback';
      html: string;
      tokens: { input: number; output: number };
      durationSeconds: number;
      fallbackReason: 'BUILD_LINT_FAILED';
    }
  | { ok: false; error: string };

export interface GenerateBuildAttemptDeps {
  storage: { readText(path: string): Promise<string | null> };
  llm: BuildLLMClient;
  lint: LintRunner;
  /** V5-P5A: assina (GET, 7 dias) cada ficheiro VO de files[] p/ a injeção. */
  signRead?: (path: string) => Promise<string | null>;
  /** V5-P5B: URL público do ficheiro BGM na biblioteca vendida do worker. */
  resolveBgmSrc?: (file: string) => string | null;
  /** V5_16 follow-up: instrumentação de fases (incidente CPU 2026-09-02). */
  perf?: PerfLog;
  /**
   * V5_32 Fase A (incidente 422 `218b1071`): canonicaliza/re-assina por PATH os
   * media capturado do HTML do LLM, ANTES do lint. O `src` transcrito pelo
   * modelo deixa de ser fonte de verdade de um token (o cruzamento
   * `asset-5`↔token de `asset-4` é reparado deterministicamente).
   *
   * O escopo autorizado (diretorias `captures/<id>`) é derivado PELO ADAPTER,
   * no servidor, a partir do vínculo da captura do projeto (`video_captures.id`)
   * — nunca do HTML nem do `tokens.json` (que o dono do projeto pode escrever;
   * V5_32 revisão de segurança). Sem este dep (testes legados) o comportamento
   * anterior mantém-se.
   */
  canonicalizeMedia?: (html: string) => Promise<CanonicalizeMediaResult>;
}

export interface GenerateBuildAttemptOpts {
  /** 0-based. O último índice válido é MAX_BUILD_RETRIES (reprovado → fallback). */
  attempt?: number;
  brief?: string;
  aspectRatio?: string;
  /** Obrigatório em attempt > 0: HTML pós-repair da tentativa anterior. */
  priorHtml?: string;
  /** Obrigatório em attempt > 0: findings do lint que reprovaram a anterior. */
  retryFeedback?: { errors?: string; warnings?: string };
}

/**
 * Executa EXATAMENTE uma tentativa de build. `attempt` 0 = geração inicial;
 * 1..MAX_BUILD_RETRIES = correção sobre `priorHtml` com o feedback de lint.
 * A tentativa no índice MAX_BUILD_RETRIES, quando reprovada, produz o
 * fallback derivado do storyboard na MESMA invocação (trabalho determinístico
 * sem LLM — não merece um request encadeado próprio).
 */
export async function generateBuildHtmlAttempt(
  deps: GenerateBuildAttemptDeps,
  inputs: {
    storyboardPath: string;
    frameMdPath: string;
    audioMetaPath: string;
    /** V4-3h: capture/extracted/tokens.json — real scraped assets for the prompt. */
    tokensPath?: string;
  },
  opts: GenerateBuildAttemptOpts = {},
): Promise<BuildAttemptResult> {
  try {
    const perf = deps.perf;
    const attempt = opts.attempt ?? 0;
    if (attempt < 0 || attempt > MAX_BUILD_RETRIES) {
      return { ok: false, error: `BUILD_ATTEMPT_OUT_OF_RANGE:${attempt}` };
    }
    if (attempt > 0 && !opts.priorHtml?.trim()) {
      return { ok: false, error: 'BUILD_PRIOR_HTML_MISSING' };
    }
    const storyboard = (await deps.storage.readText(inputs.storyboardPath)) ?? '(no storyboard)';
    const frameMd = (await deps.storage.readText(inputs.frameMdPath)) ?? '(no design spec)';
    const audioMeta = (await deps.storage.readText(inputs.audioMetaPath)) ?? '{}';
    // V4-3h: real scraped media (tokens.json bridged from video_captures).
    const tokensJson = inputs.tokensPath
      ? (await deps.storage.readText(inputs.tokensPath)) ?? ''
      : '';
    const capturedAssets = tokensJson ? buildCapturedAssetsSection(tokensJson) : '';
    // V4-04B: binding timing frames — prompt table + lint duration gate.
    const timingFrames = parseStoryboardFrames(storyboard) as StoryboardTimingFrame[];
    perf?.mark('storage_reads', { sb_bytes: storyboard.length, audio_bytes: audioMeta.length });

    const userMessage = buildBuildUserMessage(storyboard, frameMd, audioMeta, opts.brief, capturedAssets, timingFrames, opts.aspectRatio);
    // V4-3f.7 + V4-3f.17 (Fase 3): a correção leva o HTML anterior como
    // mensagem `assistant` + os findings do lint — mesmo prompt do loop legado.
    const messages: BuildLLMMessage[] = attempt === 0
      ? [
          { role: 'system', content: BUILD_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ]
      : [
          { role: 'system', content: BUILD_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: opts.priorHtml as string },
          { role: 'user', content: buildRetryMessage({ ok: false, errors: opts.retryFeedback?.errors ?? '', warnings: opts.retryFeedback?.warnings ?? '' }) },
        ];
    const llmResult = await deps.llm.call(messages);
    perf?.mark('llm_call', { attempt, out_tokens: llmResult.tokens.output, bytes: llmResult.content.length });
    const html = repairBuildHtml(llmResult.content);
    perf?.mark('repair', { attempt });
    const tokens = { input: llmResult.tokens.input, output: llmResult.tokens.output };

    // V5_32 Fase A (A3): o LLM pode cruzar paths/tokens de assets quase
    // idênticos; a canonicalização re-assina por PATH antes do lint, para o
    // retry loop nunca validar (nem o worker receber) um token de outro
    // objeto. Determinístico e best-effort no missing (a Fase B audita).
    let canonicalHtml = html;
    if (deps.canonicalizeMedia) {
      const canonical = await deps.canonicalizeMedia(html);
      canonicalHtml = canonical.html;
      perf?.mark('canonicalize_media', { fixed: canonical.fixed, missing: canonical.missing.length });
      if (canonical.missing.length > 0) {
        console.error(
          `[build] canonicalize_media deixou ${canonical.missing.length} asset(s) por reparar:`,
          canonical.missing.slice(0, 5),
        );
      }
    }

    const lintResult = await deps.lint.lint(canonicalHtml, timingFrames);
    perf?.mark('lint', { attempt, ok: lintResult.ok });
    if (lintResult.ok) {
      const injected = await injectVoTracks(canonicalHtml, audioMeta, { signRead: deps.signRead, resolveBgmSrc: deps.resolveBgmSrc });
      perf?.mark('inject_vo', { bytes: injected.length });
      return { ok: true, kind: 'success', html: injected, tokens, durationSeconds: sumClipDurationsSec(injected) };
    }
    if (attempt < MAX_BUILD_RETRIES) {
      return {
        ok: true,
        kind: 'retry',
        attemptHtml: canonicalHtml,
        lint: { errors: lintResult.errors, warnings: lintResult.warnings ?? '' },
        tokens,
      };
    }

    // Último índice reprovado — V4-3f.17 (Fase 3): fallback derivado do
    // storyboard REAL (determinístico, sem LLM, ~0 CPU extra).
    perf?.mark('fallback', { attempt });
    const fallbackHtml = buildStoryboardFallbackHtml(storyboard, opts.aspectRatio);
    const injected = await injectVoTracks(fallbackHtml, audioMeta, { signRead: deps.signRead, resolveBgmSrc: deps.resolveBgmSrc });
    perf?.mark('inject_vo', { bytes: injected.length });
    return {
      ok: true,
      kind: 'fallback',
      html: injected,
      tokens,
      durationSeconds: sumClipDurationsSec(injected),
      fallbackReason: 'BUILD_LINT_FAILED',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Generate build HTML only (no credits, no manifest update).
 * Used by the orchestrator to produce HTML for the worker dispatch.
 * The orchestrator handles credits + manifest via dispatchWorkerJob.
 *
 * V5_26: driver in-memory da primitiva de 1 tentativa (`generateBuildHtmlAttempt`)
 * — mantido para os testes/legado; o caminho de produção encadeia requests HTTP
 * de 1 tentativa no orquestrador (self-chain por CPU, STATE_CURRENT §26.1).
 *
 * Returns the validated HTML on success, or an error message on failure.
 */
export async function generateBuildHtmlOnly(
  deps: GenerateBuildAttemptDeps,
  _projectId: string,
  inputs: {
    storyboardPath: string;
    frameMdPath: string;
    audioMetaPath: string;
    /** V4-3h: capture/extracted/tokens.json — real scraped assets for the prompt. */
    tokensPath?: string;
  },
  brief?: string,
  aspectRatio?: string,
): Promise<{ ok: true; html: string; retries: number; tokens: { input: number; output: number }; durationSeconds: number; fallback?: boolean; fallbackReason?: string } | { ok: false; error: string }> {
  let attempt = 0;
  let priorHtml: string | undefined;
  let retryFeedback: { errors?: string; warnings?: string } | undefined;
  let totalInput = 0;
  let totalOutput = 0;
  for (;;) {
    const outcome = await generateBuildHtmlAttempt(deps, inputs, { attempt, brief, aspectRatio, priorHtml, retryFeedback });
    if (outcome.ok === false) return { ok: false, error: outcome.error };
    totalInput += outcome.tokens.input;
    totalOutput += outcome.tokens.output;
    if (outcome.kind === 'retry') {
      attempt += 1;
      priorHtml = outcome.attemptHtml;
      retryFeedback = outcome.lint;
      continue;
    }
    const tokens = { input: totalInput, output: totalOutput };
    if (outcome.kind === 'fallback') {
      return {
        ok: true,
        html: outcome.html,
        retries: attempt,
        tokens,
        durationSeconds: outcome.durationSeconds,
        fallback: true,
        fallbackReason: outcome.fallbackReason,
      };
    }
    return { ok: true, html: outcome.html, retries: attempt, tokens, durationSeconds: outcome.durationSeconds };
  }
}
