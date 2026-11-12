/**
 * edgeLint.ts — V4-3f.7: edge-side structural lint for build HTML
 *
 * Background: the orchestrator previously used a pass-through lint stub
 * (`{ ok: true }`), so the build retry loop never fired. The real
 * `hyperframes lint` only ran on the worker, hard-failing the whole build
 * with an opaque error (e.g. missing data-composition-id / data-width /
 * window.__timelines / clip class).
 *
 * This module re-implements, on the edge (Deno, no CLI available), the
 * subset of hyperframes lint 0.7.109 rules that LLM output most commonly
 * violates. The findings are fed back to the LLM by the build retry loop
 * (buildStep.ts), and the FALLBACK_TEMPLATE is guaranteed to pass both
 * this lint and the real worker lint.
 *
 * Rules mirrored from `hyperframes lint --json`:
 *   1. missing_composition_root    — no element with class "composition"
 *   2. root_missing_composition_id — root lacks `data-composition-id`
 *   3. root_missing_dimensions     — root lacks `data-width`/`data-height`
 *   4. missing_timeline_registry   — no `window.__timelines` registration
 *      (document-level, CLI cli.js:81810) AND per-<script> parity
 *      (`gsap_timeline_not_registered`, cli.js:82941-82945; V5.27 Fase A)
 *   4b. timeline_registry_missing_init — assignment without init
 *      (cli.js:81818-81824; V5.27 Fase A)
 *   5. timed_element_missing_clip_class — element with data-start/
 *      data-duration but no class="clip" (composition root exempt)
 *
 * V4-3f.17 (V4_3F_16_INCIDENT Fase 1) — extended rules. Findings now carry
 * severity; `ok` reflects ERROR findings only. Warnings feed the build retry
 * prompt but never fail the lint:
 *   6. gsap_non_transform_motion   — tween vars using layout props
 *      (left/top/right/bottom/width/height/margin/padding) — error
 *   7. duplicate_media_discovery_risk — img/video/audio duplicated with the
 *      same src + data-start + data-duration — warning
 *   8. timeline_track_too_dense    — more than 4 clips on one track — warning
 *   9. composition_file_too_large  — HTML above 250 lines — warning
 *  10. missing_data_track_index    — timed clip without data-track-index — error
 *  11. font_family_without_font_face — font family used without @font-face,
 *      CLI-alias or Google-Fonts-link coverage (hyperframes 0.7.109
 *      cli.js:84697-84715 parity, V5.27 Fase B) — error
 *  11b. unresolvable_font_family — used family outside every offline-
 *      resolvable set (V5.27 Fase B policy: a `local()`-only @font-face
 *      passes the CLI but renders with silent fallback) — error, feeds the
 *      build retry loop with bundled substitutes
 *  12. missing_gsap_script / missing_hyperframes_script — runtime script
 *      references absent — error
 *
 * V5_28 (incidente 422 `7f37f5b5`, `dispatch failed: worker answered 422`) —
 * hotlinked brand icons as scene media:
 *  24. favicon_icon_hotlink — an <img>/<video>/<audio> `src` pointing at a
 *      favicon/icon URL (favicon.ico, apple-touch-icon, apple-icon,
 *      android-chrome, mstile, safari-pinned-tab) — error. Brand sites
 *      bot-protect these files (openai.com/apple-icon.png → HTTP 403 HTML);
 *      the worker's `prestageExternalMedia` downloads EVERY external src and
 *      a single 403 fails the WHOLE job with 422 MEDIA_VALIDATION_FAILED —
 *      before lint, so no worker finding ever reaches the retry loop. The fix
 *      hint points at the captured `logo` asset (or omitting the logo).
 *
 * V4-04B (V4_04_TIMELINE_DURATION_RECONCILIATION §2.2) — duration gate:
 *  13. duration_mismatch_storyboard — Σ(data-duration of .clip) diverges from
 *      Σ(frame.duration) of the storyboard: error when the TOTAL deviates
 *      > 50% or any single scene deviates > 80%; warning between 10–50%.
 *  14. clip_timing_inconsistent — a clip carries data-end with
 *      start+duration ≠ end — warning.
 *
 * V5-P3B (V5_P3B_ELEMENTS_ENDPOINT.md §2.3) — stable element IDs:
 *  15. element_id_not_stable — a NON-clip element carries an `id` outside the
 *      canonical stable scheme `scene-N-{type}-K[-copy-M]` (type ∈
 *      text|img|video|audio + aliases/reservas toleradas). Isenções: root da
 *      composição (data-composition-id), `.clip`s (unidade da timeline),
 *      prefixo `__vp`, conteúdo dentro de <svg>/<script>. Elementos SEM id
 *      não são flaggados (wrappers decorativos são legítimos).
 *  16. storyboard_scene_coverage — every storyboard frame must have a
 *      corresponding root-owned clip identified by `scene-N...` or
 *      `data-scene="N"` — error.
 *  17. typography_font_too_small — text below 18px is unreadable in a
 *      full-canvas video — warning.
 *
 * V5.21 Fase H (§3.8/§2.7) — orphan-tween prevention:
 *  18. gsap_target_missing — a GSAP tween call (`.fromTo`/`.from`/`.to`/`.set`
 *      with tween vars) addresses a selector whose `#id`/`.class` tokens
 *      match no element — warning (the `#scene-5-tick` class: legacy inline
 *      tween whose element no longer exists; GSAP logs `target not found`).
 *      Regex-side mirror of `lintGsapTargets` in
 *      `vp-hyperframes-worker/window-lint.js` (repos separados não partilham
 *      import; a paridade é testada nos DOIS repos — padrão
 *      animPresets.ts/anim-presets.js). Warn-only: feeds the retry prompt but
 *      never fails the lint.
 *
 * V5.22 Fase H2 (§9) — visual-legibility pre-commit (edgeLint rules 19–23):
 *  19. text_above_scrim — a text layer (stable `scene-N-text-K` id or
 *      h1..h6/p/span) with an explicit z-index at/below a marked
 *      scrim/overlay/plate of the same scene.
 *  20. scrim_coverage — a marked scrim with parseable opacity/coverage below
 *      >=80% (>=85% over photographic plates) or coverage < 80%.
 *  21. caption_fill — a marked caption skin with parseable fill < 90% or
 *      outside the bottom-safe band.
 *  22. t0_visibility — a text/hook layer with inline `opacity: 0` at t=0
 *      (the E5/H0 sampler-vs-entrance mismatch: a t≈0 sampler photographs an
 *      empty hook).
 *  23. opacity_fromto_absolute — a GSAP tween call with a relative
 *      `opacity: '+=…'`/`'-=…'` value (must be absolute fromTo + binary
 *      0→1 via tl.set).
 *  Rules 19–23 start as WARNINGS (telemetry for one round) and become ERRORS
 *  only with `STRICT_VISUAL_LINT=1` — falsos positivos nunca bloqueiam o
 *  build por defeito. `gsap_target_missing` permanece warn-only intocado.
 *
 * V5.27 Fase A (V5_27_PLANO_CORRECAO_BUILD_LINT_TIMELINE_FONTS.md §3-A) —
 * timeline-registry parity with the pinned CLI (job 1700b4f4):
 *   • Rule 4 now mirrors the CLI per-<script> rule (cli.js:82941-82945):
 *     every inline block that CREATES a timeline (`gsap.timeline`) must carry
 *     a canonical registration IN THE SAME BLOCK — either
 *     WINDOW_TIMELINE_ASSIGN_PATTERN (cli.js:81717, RHS an identifier) or
 *     TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN (cli.js:81715). A
 *     document-level `window.__timelines` string is no longer enough: the
 *     incident's script created a local `tl` and never registered it, so the
 *     edge passed and the worker lint hard-failed.
 *   • Rule 4b (extension found during Fase A, same parity class):
 *     `timeline_registry_missing_init` mirrors cli.js:81818-81824 — an
 *     assignment without any accepted init form (`window.__timelines =
 *     window.__timelines || {};`) fails the real lint. Verified first-hand
 *     against the pinned CLI 0.7.109. `data-no-timeline` on the root exempts
 *     the document, as in the CLI (cli.js:81808).
 *   • `autoRepairComposition` step 3 splices
 *     `window.__timelines = window.__timelines || {};` +
 *     `window.__timelines["<root composition id>"] = <timeline var>;` INSIDE
 *     the offending script (right after the creation statement), replacing the
 *     separate-block injection whose ternary RHS matched neither CLI pattern
 *     and therefore never repaired anything.
 *   • A block whose timeline identifier cannot be extracted with confidence is
 *     never mutated — the finding feeds the LLM retry loop instead.
 *
 * V5_29 Fase D — background budget (regra 25, warn-only):
 *  25. background_budget — mais de 1 placa fotográfica full-bleed
 *      (`inset:0` + `object-fit:cover`, ou `position:absolute` 100%×100% +
 *      cover) sem scrim irmão de marca na mesma cena. Só UMA placa de fundo
 *      por vídeo (build prompt: `Only ONE background plate per video`);
 *      placa fotográfica EXIGE scrim tingido de marca (>=80%). Warn-only:
 *      alimenta o retry loop, nunca falha o lint.
 *
 * V5_32 Fase B — assinatura path↔token dos media de captura (regra 26, error):
 *  26. media_signed_url_inconsistent — um `src` de `<img|video|audio|source>`
 *      das NOSSAS buckets de captura (`video-assets`/`video-screenshots`) cuja
 *      URL assinada não é consistente: o token autoriza outro path (o
 *      cruzamento do incidente 218b1071: `asset-5` com o token de `asset-4`),
 *      já expirou, ou é ilegível/ausente. O worker pré-carrega TODOS os media e
 *      rejeita o job inteiro com 422 MEDIA_VALIDATION_FAILED — antes do lint,
 *      logo invisível ao retry loop até esta regra o marcar AQUI (error).
 *      Conservadora por desenho: só URLs das buckets de captura; externos,
 *      BGM do worker, `data:`/relativos e `video-artifacts` (tracks VO já
 *      assinadas na injeção) nunca são flaggados.
 *
 * Pure function, no I/O — testable under vitest.
 */

import {
  CAPTURE_MEDIA_BUCKETS,
  auditSignedMediaUrl,
  collectMediaSrcs,
  parseStorageUrl,
} from './mediaUrls.ts';

export interface EdgeLintFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  snippet?: string;
}

export interface EdgeLintResult {
  ok: boolean;
  findings: EdgeLintFinding[];
}

/** One parsed storyboard frame (subset needed by the duration gate). */
export interface StoryboardTimingFrame {
  num: number;
  title?: string;
  start: number;
  duration: number;
}

// Matches an opening tag whose class list contains the given class.
// `(?:[^"]*\s)?` consumes any preceding class tokens (ending in whitespace),
// handling the "class is first token" case (e.g. class="composition").
function findTagWithClass(html: string, cls: string): RegExpMatchArray | null {
  const re = new RegExp(
    `<[a-z][a-z0-9-]*\\b[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s|")[^>]*>`,
    'i',
  );
  return html.match(re);
}

function hasAttr(tag: string, attr: string): boolean {
  return new RegExp(`\\b${attr}\\s*=`, 'i').test(tag);
}

function classHasClip(tag: string): boolean {
  const m = tag.match(/class="([^"]*)"/i);
  if (!m) return false;
  return m[1].split(/\s+/).includes('clip');
}

function attrValue(tag: string, attr: string): string {
  const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

/** Contents of every inline <script> block (external src= scripts excluded). */
function inlineScripts(source: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

// Layout properties that hyperframes lint rejects inside GSAP tweens because
// they snap to integer device pixels (the V4-3f.16 incident: `left` tween on
// #laser-scan failed the worker lint as gsap_non_transform_motion).
const NON_TRANSFORM_PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin', 'padding'];

// ── V5.27 Fase A — timeline-registry parity with hyperframes 0.7.109 ───────
// Patterns transplanted verbatim from the pinned CLI. Re-pin both together
// with `hyperframes` in the worker Dockerfile (currently 0.7.109).

/** cli.js:81717 — `window.__timelines["main"] = tl` (RHS must be an identifier). */
const WINDOW_TIMELINE_ASSIGN_PATTERN =
  /window\.__timelines(?:\[\s*(?:["']([^"']+)["']|[A-Za-z_$][\w$.]*)\s*\]|\.\s*([A-Za-z_$][\w$]*))\s*=\s*([A-Za-z_$][\w$]*)/i;

/** cli.js:81715 — `window.__timelines = { main: tl }` (non-empty object literal). */
const TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN =
  /window\.__timelines\s*=\s*\{\s*(?:["'][^"']+["']|[A-Za-z_$][\w$]*)\s*:/i;

/** cli.js:81714 — any accepted `window.__timelines` initialization form. */
const TIMELINE_REGISTRY_INIT_PATTERN =
  /window\.__timelines\s*=\s*window\.__timelines\s*\|\|\s*\{\}|window\.__timelines\s*=\s*\{\}|window\.__timelines\s*\?\?=\s*\{\}/i;

/** cli.js:81716 — `window.__timelines[…] = …` (RHS not validated at this level). */
const TIMELINE_REGISTRY_ASSIGN_PATTERN =
  /window\.__timelines(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*=/i;

/**
 * CLI parity (cli.js:82943-82945): true when a script block CREATES a GSAP
 * timeline but carries no canonical registration in the SAME block.
 * `??=`, `Object.assign(...)`, a sibling script and a bare read
 * (`(window.__timelines || {})["main"]`) are not registrations for the CLI.
 */
function scriptCreatesUnregisteredTimeline(script: string): boolean {
  if (!/gsap\.timeline/.test(script)) return false;
  return !(
    WINDOW_TIMELINE_ASSIGN_PATTERN.test(script)
    || TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN.test(script)
  );
}

/** Index right after the `)` matching the `(` at `argsStart` (string-aware). */
function matchParenEnd(source: string, argsStart: number): number {
  let depth = 1;
  let i = argsStart;
  let str: string | null = null;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (str) {
      if (c === '\\') i += 1;
      else if (c === str) str = null;
    } else if (c === '"' || c === "'" || c === '`') {
      str = c;
    } else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    i += 1;
  }
  return i;
}

/** Remove JS line/block comments before reasoning about a statement segment. */
function stripJsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1 ');
}

/**
 * Identifier assigned to the timeline creation at `callStart`:
 * `const tl = ` → "tl"; `tl = ` → "tl"; `window.tl = ` → "window.tl".
 * Returns null for anything not confidently an assignment — the repair then
 * refuses to mutate (rule 4 hands the block to the LLM retry loop instead).
 */
function timelineAssignedIdentifier(content: string, callStart: number): string | null {
  const before = content.slice(0, callStart);
  const m = /(?:^|[;{}\n\r])\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*=\s*$/
    .exec(before);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

/**
 * Boundary right after the statement that owns the creation call (its first
 * top-level `;`), or the index of the enclosing `}` — so the registration is
 * spliced WITHOUT splitting a chained `gsap.timeline({...}).fromTo(...)`
 * expression. Returns null when no safe boundary exists or the segment would
 * land after a control-flow exit (`return`/`throw`/`break`/`continue`).
 */
function timelineRegistrationIndex(content: string, callEnd: number): number | null {
  let i = callEnd;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let str: string | null = null;
  let boundary: number | null = null;
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];
    if (str) {
      if (c === '\\') { i += 2; continue; }
      if (c === str) str = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = content.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = content.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; i += 1; continue; }
    if (c === '(') parens += 1;
    else if (c === ')') parens = Math.max(0, parens - 1);
    else if (c === '[') brackets += 1;
    else if (c === ']') brackets = Math.max(0, brackets - 1);
    else if (c === '{') braces += 1;
    else if (c === '}') {
      if (parens === 0 && brackets === 0 && braces === 0) { boundary = i; break; }
      braces = Math.max(0, braces - 1);
    } else if (c === ';' && parens === 0 && brackets === 0 && braces === 0) {
      boundary = i + 1;
      break;
    }
    i += 1;
  }
  if (boundary === null) return null;
  const segment = stripJsComments(content.slice(callEnd, boundary));
  if (/\b(?:return|throw|break|continue)\b/.test(segment)) return null;
  return boundary;
}

/**
 * V5.27 Fase A — repair step 3. Registers each timeline INSIDE the script
 * block that creates it (cli.js:82941-82945 parity). The previous repair
 * injected a separate block whose ternary RHS
 * (`(typeof gsap !== "undefined") ? ...`) matches neither CLI pattern, so it
 * could never fix this error class — it only masked the edge check.
 * Idempotent: canonical blocks are never touched. A block whose identifier is
 * not extractable is left untouched for the LLM retry loop.
 */
function repairTimelineRegistry(html: string, compositionId: string): string {
  const key = /^[\w-]+$/.test(compositionId) ? compositionId : 'main';
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let out = html.replace(scriptRe, (full, attrs: string, content: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return full;
    if (!scriptCreatesUnregisteredTimeline(content)) return full;
    const call = /\bgsap\s*\.\s*timeline\s*\(/.exec(content);
    if (!call) return full;
    const identifier = timelineAssignedIdentifier(content, call.index);
    if (!identifier) return full;
    const callEnd = matchParenEnd(content, call.index + call[0].length);
    const insertAt = timelineRegistrationIndex(content, callEnd);
    if (insertAt === null) return full;
    const lineStart = content.lastIndexOf('\n', call.index) + 1;
    const indent = /^[ \t]*/.exec(content.slice(lineStart, call.index))?.[0] ?? '';
    const registration =
      `${indent}window.__timelines = window.__timelines || {};\n`
      + `${indent}window.__timelines["${key}"] = ${identifier};`;
    return `<script${attrs}>${content.slice(0, insertAt)}\n${registration}\n${content.slice(insertAt)}</script>`;
  });

  // No timeline is created anywhere and no valid registry exists (a bare read
  // does not count — CLI triple): keep the last-resort canonical
  // registration. It is self-registered in the SAME block, so it satisfies
  // the per-script CLI rule instead of becoming a new offender (the old
  // ternary block did the opposite).
  const hasRegistry = TIMELINE_REGISTRY_INIT_PATTERN.test(out)
    || TIMELINE_REGISTRY_ASSIGN_PATTERN.test(out)
    || TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN.test(out);
  if (!hasRegistry && !/gsap\.timeline/.test(out)) {
    const registry =
      '<script>\nwindow.__timelines = window.__timelines || {};\n'
      + `if (typeof gsap !== "undefined") { window.__timelines["${key}"] = gsap.timeline({ paused: true }); }\n`
      + '</script>\n';
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${registry}</body>`);
    } else {
      out += `\n${registry}`;
    }
  }
  return out;
}

/**
 * Locate GSAP tween call spans (.fromTo/.from/.to/.set) inside a script.
 * Returns arg-region boundaries: `argsStart` is right after the opening
 * paren, `end` right after the matching closing paren. String-aware so
 * parens inside string literals don't break the bracket scan.
 */
function tweenCallSpans(script: string): Array<{ callStart: number; argsStart: number; end: number }> {
  const spans: Array<{ callStart: number; argsStart: number; end: number }> = [];
  const callRe = /\.(fromTo|from|to|set)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(script)) !== null) {
    const argsStart = m.index + m[0].length;
    spans.push({ callStart: m.index, argsStart, end: matchParenEnd(script, argsStart) });
  }
  return spans;
}

/**
 * Scan inline scripts for GSAP tween calls (.fromTo/.from/.to/.set) whose
 * vars objects use layout properties. Returns one entry per offending call
 * with the offending property list + snippet. Pure regex + bracket scan —
 * no JS parsing, good enough for LLM output screening.
 */
function findNonTransformMotion(script: string): Array<{ props: string[]; snippet: string }> {
  const calls: Array<{ props: string[]; snippet: string }> = [];
  for (const { callStart, argsStart, end } of tweenCallSpans(script)) {
    const callBody = script.slice(argsStart, Math.max(argsStart, end - 1));
    // Collect top-level {...} argument objects.
    const objs: string[] = [];
    let j = 0;
    while (j < callBody.length) {
      if (callBody[j] === '{') {
        let d = 0;
        let k = j;
        let s: string | null = null;
        while (k < callBody.length) {
          const ch = callBody[k];
          if (s) {
            if (ch === '\\') k += 1;
            else if (ch === s) s = null;
          } else if (ch === '"' || ch === "'" || ch === '`') s = ch;
          else if (ch === '{') d += 1;
          else if (ch === '}') {
            d -= 1;
            if (d === 0) break;
          }
          k += 1;
        }
        objs.push(callBody.slice(j, k + 1));
        j = k + 1;
      } else j += 1;
    }
    const props = new Set<string>();
    for (const obj of objs) {
      const keyRe = /[,{]\s*([a-zA-Z_$][\w$]*)\s*:/g;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(obj)) !== null) {
        if (NON_TRANSFORM_PROPS.includes(km[1])) props.add(km[1]);
      }
      // Leading-key case: `{ left: ... }`.
      const lead = obj.match(/^\{\s*([a-zA-Z_$][\w$]*)\s*:/);
      if (lead && NON_TRANSFORM_PROPS.includes(lead[1])) props.add(lead[1]);
    }
    if (props.size > 0) {
      calls.push({
        props: [...props],
        snippet: script.slice(callStart, end).trim().slice(0, 160),
      });
    }
  }
  return calls;
}

// Mechanical tween repair map (V4-3f.17 Fase 2): layout props with direct
// transform equivalents. width/height/margin/padding are NOT renamed — the
// scale conversion is context-dependent and stays an LLM lint fix.
const TWEEN_KEY_RENAME: Record<string, string> = { left: 'x', top: 'y' };

/** Rename left/top tween keys inside one call span, skipping string literals. */
function renameTweenKeys(segment: string): string {
  let out = '';
  let i = 0;
  let inStr: string | null = null;
  while (i < segment.length) {
    const c = segment[i];
    if (inStr) {
      if (c === '\\') {
        out += segment.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      out += c;
      i += 1;
      continue;
    }
    const m = /^(left|top)(\s*:)/.exec(segment.slice(i));
    if (m) {
      // Only rename object keys (preceded by `{`, `,` or start of segment),
      // never identifiers or label-like tokens.
      let p = out.length - 1;
      while (p >= 0 && /\s/.test(out[p])) p -= 1;
      const prev = p >= 0 ? out[p] : '';
      if (prev === '{' || prev === ',' || prev === '') {
        out += TWEEN_KEY_RENAME[m[1]] + m[2];
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function repairScriptTweens(script: string): string {
  const spans = tweenCallSpans(script);
  if (spans.length === 0) return script;
  let out = '';
  let cursor = 0;
  for (const { callStart, end } of spans) {
    if (callStart < cursor) continue; // nested/overlapping — already covered
    out += script.slice(cursor, callStart);
    out += renameTweenKeys(script.slice(callStart, end));
    cursor = end;
  }
  out += script.slice(cursor);
  // V5.27 Fase C4: drop the earlier of two overlapping duplicate tweens.
  return dedupeOverlappingTweens(out);
}

// ── V5.27 Fase C4 — dedupe of overlapping duplicate tweens ─────────────────
// The build retry loop feeds rejected HTML back to the LLM, which tends to
// ADD tweens without removing the originals (V5_27 incident: two identical
// opacity `fromTo` on `#scene-6-text-2` at 32.1s/33.4s → `overlapping_gsap_tweens`
// warning + visible opacity jumps). When two `.fromTo`/`.to` calls address the
// SAME target with an IDENTICAL end-state, neither carries `overwrite: "auto"`
// and their windows overlap, the earlier is dead weight: keep the last, drop
// the earlier statement. Pure regex + bracket scan — no JS parsing, good enough
// for LLM output screening (same philosophy as `findNonTransformMotion`).

/** GSAP default tween duration (s) when `duration` is absent from the vars. */
const GSAP_DEFAULT_TWEEN_DURATION = 0.5;

/** Replace every JS string literal with `""` (template literals included). */
function stripJsStrings(source: string): string {
  return source.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '""');
}

/** Split a call argument list on top-level commas (string/depth-aware). */
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let str: string | null = null;
  let start = 0;
  for (let i = 0; i < argsText.length; i += 1) {
    const c = argsText[i];
    if (str) {
      if (c === '\\') i += 1;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      args.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  args.push(argsText.slice(start));
  return args;
}

/** First scalar `key: <number>` in a vars object, else the fallback. */
function tweenScalarVar(varsText: string, key: string, fallback: number): number {
  const m = new RegExp(`\\b${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(stripJsComments(varsText));
  if (!m) return fallback;
  const value = parseFloat(m[1]);
  return Number.isFinite(value) ? value : fallback;
}

/** End-state key for comparison: strip timing meta keys, unify quotes/space. */
function tweenEndStateKey(varsText: string): string {
  const withoutMeta = stripJsComments(varsText).replace(
    /,?\s*\b(duration|ease|delay|overwrite|stagger|repeat|yoyo|immediateRender|paused)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-+\w$.]+)\s*/g,
    '',
  );
  return withoutMeta.replace(/\s+/g, '').replace(/"/g, "'");
}

interface DedupeTweenCall {
  callStart: number;
  end: number;
  target: string;
  endState: string;
  start: number;
  duration: number;
  overwriteAuto: boolean;
}

/**
 * Parse one `.fromTo`/`.to` span into a dedupe candidate. Returns null when
 * the call is not confidently a plain tween (non-literal target, non-numeric
 * position, missing args) — the repair then refuses to touch it.
 */
function parseDedupeCall(script: string, callStart: number, end: number): DedupeTweenCall | null {
  const methodMatch = /^\.(fromTo|to)\s*\(/.exec(script.slice(callStart, callStart + 8));
  if (!methodMatch) return null;
  const argsStart = callStart + methodMatch[0].length;
  const args = splitTopLevelArgs(script.slice(argsStart, Math.max(argsStart, end - 1)));
  const isFromTo = methodMatch[1] === 'fromTo';
  const targetRaw = args[0] ?? '';
  const varsRaw = isFromTo ? (args[2] ?? '') : (args[1] ?? '');
  const positionRaw = isFromTo ? (args[3] ?? '') : (args[2] ?? '');
  if (!varsRaw || !positionRaw) return null;
  const targetMatch = /^\s*(["'])([\s\S]*)\1\s*$/.exec(targetRaw);
  if (!targetMatch) return null;
  const position = parseFloat(positionRaw.trim());
  if (!Number.isFinite(position)) return null;
  const fromVars = isFromTo ? (args[1] ?? '') : '';
  const argsText = script.slice(argsStart, Math.max(argsStart, end - 1));
  return {
    callStart,
    end,
    target: `'${targetMatch[2].trim()}'`,
    endState: tweenEndStateKey(varsRaw),
    start: position + tweenScalarVar(varsRaw, 'delay', 0),
    duration: Math.max(
      0,
      tweenScalarVar(varsRaw, 'duration', tweenScalarVar(fromVars, 'duration', GSAP_DEFAULT_TWEEN_DURATION)),
    ),
    overwriteAuto: /\boverwrite\s*:\s*(["']?)auto\1/i.test(stripJsComments(argsText)),
  };
}

/**
 * Statement span owning [callStart, callEnd): from after the previous
 * top-level `;`/`{`/`}` to the next top-level `;` (included) or `}`/EOF
 * (excluded). Returns null for chained calls (`...).to(...`) or when no safe
 * boundary exists. Forward scan from 0 keeps the backward search
 * string/comment-aware without reverse scanning.
 */
function tweenStatementSpan(script: string, callStart: number, callEnd: number): { start: number; end: number } | null {
  let boundary = 0;
  let depth = 0;
  let str: string | null = null;
  let i = 0;
  while (i < callStart) {
    const c = script[i];
    const next = script[i + 1];
    if (str) {
      if (c === '\\') i += 2;
      else {
        if (c === str) str = null;
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = script.indexOf('\n', i);
      if (nl < 0 || nl >= callStart) break;
      i = nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = script.indexOf('*/', i + 2);
      if (close < 0 || close >= callStart) break;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '(' || c === '[' || c === '{') {
      if (c === '{' && depth === 0) boundary = i + 1;
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      if (c === '}' && depth === 0) boundary = i + 1;
    } else if (c === ';' && depth === 0) boundary = i + 1;
    i += 1;
  }

  // Forward: the next non-space/comment char must be `;`, `}` or EOF — a `.`
  // means the call is chained (`tl.fromTo(...).to(...)`) and untouchable.
  let j = callEnd;
  let fstr: string | null = null;
  let fdepth = 0;
  while (j < script.length) {
    const c = script[j];
    const next = script[j + 1];
    if (fstr) {
      if (c === '\\') j += 2;
      else {
        if (c === fstr) fstr = null;
        j += 1;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = script.indexOf('\n', j);
      if (nl < 0) {
        j = script.length;
        break;
      }
      j = nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = script.indexOf('*/', j + 2);
      if (close < 0) {
        j = script.length;
        break;
      }
      j = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      fstr = c;
      j += 1;
      continue;
    }
    if (/\s/.test(c)) {
      j += 1;
      continue;
    }
    if (c === '.' && fdepth === 0) return null; // chained — never split a chain
    if (c === '(' || c === '[' || c === '{') fdepth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (fdepth === 0) return { start: boundary, end: j };
      fdepth = Math.max(0, fdepth - 1);
    } else if (c === ';' && fdepth === 0) return { start: boundary, end: j + 1 };
    j += 1;
  }
  return { start: boundary, end: j };
}

/** True when the statement is a plain `receiver.fromTo(...)/.to(...)` line. */
function isPlainTweenStatement(statement: string): boolean {
  const code = stripJsComments(stripJsStrings(statement)).trim();
  if (!/^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*(fromTo|to)\s*\(/.test(code)) return false;
  if (/\bgsap\s*\.\s*timeline\b/.test(code)) return false;
  if (/window\s*\.\s*__timelines\b/.test(code)) return false;
  if (/\b(?:return|throw|break|continue)\b/.test(code)) return false;
  const calls = code.match(/\.(fromTo|from|to|set)\s*\(/g) ?? [];
  return calls.length === 1;
}

/**
 * Drop earlier overlapping duplicate `.fromTo`/`.to` statements (keep last).
 * Conservative: only standalone plain-tween statements with literal targets
 * and numeric positions participate; anything else is left for the LLM retry
 * loop. Single pass, idempotent.
 */
function dedupeOverlappingTweens(script: string): string {
  const calls: DedupeTweenCall[] = [];
  for (const { callStart, end } of tweenCallSpans(script)) {
    if (/^\.(from|set)\s*\(/.test(script.slice(callStart, callStart + 6))) continue;
    const parsed = parseDedupeCall(script, callStart, end);
    if (parsed) calls.push(parsed);
  }
  if (calls.length < 2) return script;

  const doomed = new Set<number>();
  for (let a = 0; a < calls.length; a += 1) {
    for (let b = 0; b < calls.length; b += 1) {
      if (a === b) continue;
      const earlier = calls[a];
      const later = calls[b];
      if (earlier.target !== later.target) continue;
      if (earlier.endState !== later.endState) continue;
      if (earlier.overwriteAuto || later.overwriteAuto) continue;
      if (!(later.start >= earlier.start)) continue;
      if (later.start >= earlier.start + earlier.duration) continue; // disjoint
      if (later.callStart === earlier.callStart) continue;
      // With equal starts the later-IN-SOURCE call wins.
      if (later.start === earlier.start && later.callStart < earlier.callStart) continue;
      doomed.add(a);
      break;
    }
  }
  if (doomed.size === 0) return script;

  const spans: Array<{ start: number; end: number }> = [];
  for (const index of doomed) {
    const call = calls[index];
    const span = tweenStatementSpan(script, call.callStart, call.end);
    if (!span) continue;
    if (!isPlainTweenStatement(script.slice(span.start, span.end))) continue;
    spans.push(span);
  }
  if (spans.length === 0) return script;

  spans.sort((x, y) => y.start - x.start);
  let out = script;
  for (const span of spans) {
    out = `${out.slice(0, span.start)}${out.slice(span.end)}`;
  }
  return out;
}

/**
 * V4-3f.17 (Fase 2): deterministic mechanical repair of the V4-3f.16 error
 * class — GSAP tweens using `left`/`top` are rewritten to their transform
 * equivalents (`x`/`y`) before lint, so the composition no longer fails the
 * worker's gsap_non_transform_motion rule. Only inline <script> tween calls
 * are touched; CSS, markup and string literals are never modified.
 *
 * V5.27 Fase C4: second pass drops the EARLIER of two overlapping duplicate
 * tweens (same `.fromTo`/`.to` target + identical end-state, neither with
 * `overwrite: "auto"`, temporally overlapping) — the retry loop feeds rejected
 * HTML back to the LLM, which re-adds tweens without removing the originals.
 * Keeps the LAST occurrence; standalone statements only (never chains,
 * creation/registration lines or control-flow statements).
 */
export function repairMotionTweens(html: string): string {
  const source = html ?? '';
  return source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return full;
    const repaired = repairScriptTweens(body);
    if (repaired === body) return full;
    return `<script${attrs}>${repaired}</script>`;
  });
}

// ── V5.27 Fase B — font-family parity with hyperframes 0.7.109 ─────────────
// The collection regex, the name normalization, the generic-family set and
// the auto-resolved alias keys are transplanted from the pinned CLI; the
// <link> exemption is restricted to the families NAMED in the link (plus
// @import). CLI verdicts were verified first-hand (`lint --json` fixtures,
// plan Anexo C) — in particular: `"berkeley mono"` in <style> errors,
// `Playfair Display`/`Poppins`/`Inter` are alias-exempt, `Space Grotesk` is
// NOT exempt, a Google link for Inter does not cover other families, and a
// `local()` @font-face satisfies the CLI case-insensitively.
//
// Deliberate superset: the CLI scans <style> blocks only
// (parseHtmlStructure → blocks.style); the edge scans the whole document
// INCLUDING inline style="" attributes, where the renderer would equally
// fall back silently. A family seen only inline is repaired/flagged the same
// way — the injected @font-face is valid for the CLI, so parity never
// regresses (the edge can only be stricter, never looser, than the CLI).

/** cli.js:84638-84662 — generic/system keywords that never need @font-face. */
const CLI_GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'fangsong', '-apple-system', 'blinkmacsystemfont',
  'inherit', 'initial', 'unset', 'revert',
]);

/**
 * cli.js:73112-73190 (FONT_ALIAS_MAP2 keys) — families the renderer
 * auto-resolves to bundled fonts for cross-platform consistency. The CLI
 * `font_family_without_font_face` rule (cli.js:84704-84706) exempts every key
 * of this map, so the edge must too. Re-pin together with `hyperframes` in
 * the worker Dockerfile (currently 0.7.109).
 */
const CLI_FONT_ALIAS_KEYS = new Set([
  // ── Canonical bundled fonts (self-referencing) ──
  'inter', 'montserrat', 'outfit', 'nunito', 'oswald', 'league gothic',
  'archivo black', 'space mono', 'ibm plex mono', 'jetbrains mono',
  'eb garamond', 'playfair display', 'source code pro', 'noto sans jp',
  'roboto', 'open sans', 'lato', 'poppins',
  // ── Common aliases → nearest canonical ──
  'helvetica neue', 'helvetica', 'arial', 'helvetica bold', 'futura',
  'din alternate', 'arial black', 'bebas neue', 'courier new', 'courier',
  'garamond', 'noto sans japanese', 'segoe ui',
  // ── macOS sans-serif system fonts → inter ──
  'sf pro', 'sf pro display', 'sf pro text', 'sf pro rounded', 'avenir',
  'avenir next', 'lucida grande', 'geneva', 'optima',
  // ── Windows sans-serif system fonts → inter ──
  'verdana', 'tahoma', 'trebuchet ms', 'calibri', 'candara', 'corbel',
  'lucida sans', 'lucida sans unicode',
  // ── Linux sans-serif system fonts → inter ──
  'noto sans', 'dejavu sans', 'liberation sans',
  // ── Monospace system fonts → jetbrains-mono ──
  'sf mono', 'menlo', 'monaco', 'consolas', 'lucida console',
  'lucida sans typewriter', 'andale mono', 'dejavu sans mono',
  'liberation mono',
  // ── Serif system fonts → eb-garamond ──
  'georgia', 'palatino', 'palatino linotype', 'book antiqua', 'cambria',
  'times', 'times new roman', 'dejavu serif', 'liberation serif',
]);

/**
 * CLI parity (cli.js:81002-81006): trim → strip a trailing `!important` →
 * strip one surrounding quote → trim → lowercase. Rejects empty names and
 * function-like values (`var(--x)`), which the CLI never collects either.
 */
function normalizeUsedFontName(part: string): string | null {
  const name = part.trim().replace(/\s*!important\s*$/i, '').replace(/^['"]|['"]$/g, '').trim().toLowerCase();
  if (!name || name.includes('(') || name.includes(')')) return null;
  return name;
}

/**
 * Scan source for font purposes: <script> bodies (JS strings can mention
 * `font-family:` without using a font), HTML comments and CSS comments are
 * removed first — the CLI strips CSS comments per style block (cli.js:80983)
 * and never scans scripts for fonts.
 */
function fontScanSource(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * CLI parity (cli.js:81007-81025, propRe `/font-family\s*:\s*([^;}{]+)/gi`):
 * collect every used non-generic family. @font-face blocks are excluded from
 * the USED set exactly like the CLI does (cli.js:81012) — a declaration is
 * not a use (it is still recorded by `declaredFontFamilies` below).
 */
function collectFontFamilies(source: string): Set<string> {
  const families = new Set<string>();
  const scan = fontScanSource(source).replace(/@font-face\s*\{[^}]*\}/gi, ' ');
  const declRe = /font-family\s*:\s*([^;}{]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(scan)) !== null) {
    for (const part of m[1].split(',')) {
      const name = normalizeUsedFontName(part);
      if (name && !CLI_GENERIC_FAMILIES.has(name)) families.add(name);
    }
  }
  return families;
}

/** CLI parity (cli.js:81037-81045): `+` → space, URI-decode, lowercase. */
function normalizeGoogleFontFamily(name: string): string | null {
  const decoded = name.replace(/\+/g, ' ').trim();
  if (!decoded) return null;
  try {
    return decodeURIComponent(decoded).trim().toLowerCase() || null;
  } catch {
    return decoded.toLowerCase();
  }
}

/** CLI parity (cli.js:81046-81063): families out of one Google Fonts URL. */
function extractGoogleFontFamiliesFromUrl(rawUrl: string): string[] {
  const url = rawUrl.replace(/&amp;/gi, '&');
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://fonts.googleapis.com');
  } catch {
    return [];
  }
  if (parsed.hostname.toLowerCase() !== 'fonts.googleapis.com') return [];
  const families: string[] = [];
  for (const value of parsed.searchParams.getAll('family')) {
    for (const familySpec of value.split('|')) {
      const family = normalizeGoogleFontFamily(familySpec.split(':')[0] ?? '');
      if (family) families.push(family);
    }
  }
  return families;
}

/**
 * CLI parity (cli.js:81064-81081): families named in Google Fonts <link>
 * hrefs (`family=` params) and in `@import`ed Google Fonts stylesheets.
 * The pre-Fase-B edge exempted the WHOLE document on ANY fonts link — the
 * incident's `"berkeley mono"` rode along a Google link for another family.
 */
function collectGoogleFontFamilies(scan: string): Set<string> {
  const families = new Set<string>();
  const linkHrefRe = /<link\b[^>]*\bhref\s*=\s*(?:(["'])([^"']*fonts\.googleapis\.com[^"']*)\1|([^\s>]*fonts\.googleapis\.com[^\s>]*))[^>]*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkHrefRe.exec(scan)) !== null) {
    const href = lm[2] || lm[3];
    if (href) for (const f of extractGoogleFontFamiliesFromUrl(href)) families.add(f);
  }
  const importUrlRe = /@import\s+(?:url\(\s*)?(["']?)([^"')\s]*fonts\.googleapis\.com[^"')\s]*)\1\s*\)?/gi;
  let im: RegExpExecArray | null;
  while ((im = importUrlRe.exec(scan)) !== null) {
    if (im[2]) for (const f of extractGoogleFontFamiliesFromUrl(im[2])) families.add(f);
  }
  return families;
}

/**
 * Declared @font-face families (CLI parity, cli.js:80986-81001 — any src
 * satisfies `font_family_without_font_face`) plus the subset declared with a
 * real `src: url(...)` (only those count as offline-resolvable for the
 * `unresolvable_font_family` policy rule) and the Google Fonts families.
 */
function declaredFontFamilies(source: string): {
  faces: Set<string>;
  urlFaces: Set<string>;
  googleFonts: Set<string>;
} {
  const faces = new Set<string>();
  const urlFaces = new Set<string>();
  const scan = fontScanSource(source);
  const faceBlockRe = /@font-face\s*\{[^}]*\}/gi;
  const familyRe = /font-family\s*:\s*(['"]?)([^;'"]+)\1/i;
  let b: RegExpExecArray | null;
  while ((b = faceBlockRe.exec(scan)) !== null) {
    const fam = b[0].match(familyRe);
    if (fam?.[2]) {
      const name = fam[2].trim().toLowerCase();
      if (name) {
        faces.add(name);
        if (/url\(/i.test(b[0])) urlFaces.add(name);
      }
    }
  }
  return { faces, urlFaces, googleFonts: collectGoogleFontFamilies(scan) };
}

/**
 * Automatically inject @font-face declarations for any non-generic font
 * families used in CSS or inline styles that lack a @font-face declaration.
 * This guarantees hyperframes lint 0.7.109 font_family_without_font_face passes.
 */
export function repairFontFaces(html: string): string {
  const source = html ?? '';
  const families = collectFontFamilies(source);
  if (families.size === 0) return source;

  // V5.27 Fase B: restricted exemption (CLI parity) — only families declared
  // via @font-face, auto-resolved by the CLI alias map, or NAMED in a Google
  // Fonts link/@import skip the repair. A link for another family no longer
  // covers the rest of the document.
  const { faces, googleFonts } = declaredFontFamilies(source);

  const missing: string[] = [];
  for (const family of families) {
    if (faces.has(family)) continue;
    if (CLI_FONT_ALIAS_KEYS.has(family)) continue;
    if (googleFonts.has(family.replace(/\+/g, ' '))) continue;
    missing.push(family);
  }

  if (missing.length === 0) return source;

  const fontFaceRules = missing
    .map(
      (f) =>
        `@font-face {\n  font-family: '${f}';\n  src: local('${f}'), local('${f.replace(/\s+/g, '')}');\n}`,
    )
    .join('\n');

  if (/<style\b[^>]*>/i.test(source)) {
    return source.replace(/(<style\b[^>]*>)/i, `$1\n${fontFaceRules}\n`);
  } else if (/<\/head>/i.test(source)) {
    return source.replace(/<\/head>/i, `<style>\n${fontFaceRules}\n</style>\n</head>`);
  } else if (/<body\b/i.test(source)) {
    return source.replace(/<body\b/i, `<head>\n<style>\n${fontFaceRules}\n</style>\n</head>\n<body`);
  }
  return `<style>\n${fontFaceRules}\n</style>\n${source}`;
}

// ─── V4-04B: duration reconciliation gate ───────────────────────────────────

/** Tolerances for the duration_mismatch_storyboard rule (spec §2.2). */
const DURATION_TOTAL_ERROR = 0.5; // >50% total deviation → error
const DURATION_TOTAL_WARN = 0.1; // 10–50% → warning
const DURATION_SCENE_ERROR = 0.8; // any scene >80% off → error

interface ParsedClipTiming {
  id: string;
  start: number;
  duration: number;
  end?: number;
}

/** Extract ordered .clip timings (composition root exempt). */
function parseClipTimings(source: string): ParsedClipTiming[] {
  const clips: ParsedClipTiming[] = [];
  const tagRe = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(source)) !== null) {
    const tag = m[0];
    if (!classHasClip(tag) || hasAttr(tag, 'data-composition-id')) continue;
    const durationRaw = attrValue(tag, 'data-duration');
    if (!durationRaw) continue;
    const duration = parseFloat(durationRaw);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const start = parseFloat(attrValue(tag, 'data-start')) || 0;
    const endRaw = attrValue(tag, 'data-end');
    const end = endRaw ? parseFloat(endRaw) : undefined;
    const idMatch = tag.match(/\bid\s*=\s*"([^"]*)"/i);
    clips.push({ id: idMatch?.[1] ?? `clip-${clips.length + 1}`, start, duration, end });
  }
  return clips;
}

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * Extract scene numbers only from clips owned by the document's root
 * composition. A small tag stack is sufficient here and prevents clips in
 * nested sub-compositions from satisfying root storyboard coverage.
 */
function rootOwnedSceneNumbers(source: string): Set<number> {
  const scenes = new Set<number>();
  const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const tagRe = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;
  const stack: Array<{ tagName: string; composition: number | null }> = [];
  let rootComposition: number | null = null;
  let nextComposition = 1;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(markup)) !== null) {
    const tag = m[0];
    const tagName = m[1].toLowerCase();
    if (tag.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const entry = stack.pop();
        if (entry?.tagName === tagName) break;
      }
      continue;
    }

    const inheritedComposition = stack.length > 0
      ? stack[stack.length - 1].composition
      : null;
    const isComposition = hasAttr(tag, 'data-composition-id');
    const ownComposition = isComposition ? nextComposition++ : inheritedComposition;
    if (rootComposition === null && isComposition && findTagWithClass(tag, 'composition')) {
      rootComposition = ownComposition;
    }

    if (
      rootComposition !== null
      && inheritedComposition === rootComposition
      && !isComposition
      && classHasClip(tag)
    ) {
      const id = attrValue(tag, 'id');
      const idMatch = id.match(/^scene-(\d+)(?:-|$)/i);
      const dataScene = attrValue(tag, 'data-scene').trim();
      const dataSceneMatch = dataScene.match(/^\d+$/);
      if (idMatch) scenes.add(parseInt(idMatch[1], 10));
      if (dataSceneMatch) scenes.add(parseInt(dataScene, 10));
    }

    if (!VOID_HTML_TAGS.has(tagName) && !/\/\s*>$/.test(tag)) {
      stack.push({ tagName, composition: ownComposition });
    }
  }

  return scenes;
}

/** Every storyboard frame must be represented by a root-owned scene clip. */
export function checkStoryboardSceneCoverage(
  html: string,
  frames: StoryboardTimingFrame[],
): EdgeLintFinding[] {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const sceneNumbers = rootOwnedSceneNumbers(html);
  const frameNumbers = [...new Set(frames.map((frame) => frame.num))];
  return frameNumbers
    .filter((frameNum) => !sceneNumbers.has(frameNum))
    .map((frameNum) => ({
      code: 'storyboard_scene_coverage',
      severity: 'error' as const,
      message:
        `Storyboard frame ${frameNum} has no corresponding root-owned scene clip. `
        + `Fix hint: add a root-owned class="clip" with id="scene-${frameNum}" or `
        + `data-scene="${frameNum}", using the frame's binding timing from the storyboard table.`,
    }));
}

/**
 * V4-04B §2.2: compare the composition's clip durations against the
 * storyboard frames (by order). Emits at most one total finding plus one
 * finding per diverging scene, with actionable fix hints.
 */
export function checkDurationMismatch(
  html: string,
  frames: StoryboardTimingFrame[],
): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  if (!Array.isArray(frames) || frames.length === 0) return findings;
  const clips = parseClipTimings(html);
  if (clips.length === 0) return findings;

  const storyboardTotal = frames.reduce((acc, f) => acc + f.duration, 0);
  const compositionTotal = clips.reduce((acc, c) => acc + c.duration, 0);
  if (storyboardTotal <= 0 || compositionTotal <= 0) return findings;

  const totalDeviation = Math.abs(compositionTotal - storyboardTotal) / storyboardTotal;

  // Per-scene divergence (order of clips ↔ order of frames).
  const sceneFindings: EdgeLintFinding[] = [];
  const count = Math.min(clips.length, frames.length);
  for (let i = 0; i < count; i += 1) {
    const clip = clips[i];
    const frame = frames[i];
    if (frame.duration <= 0) continue;
    const dev = Math.abs(clip.duration - frame.duration) / frame.duration;
    if (dev > DURATION_SCENE_ERROR) {
      sceneFindings.push({
        code: 'duration_mismatch_storyboard',
        severity: 'error',
        message:
          `${clip.id} has data-duration=${clip.duration}s but the storyboard frame ${frame.num} `
          + `requires ≈${frame.duration}s (${Math.round(dev * 100)}% off). `
          + `Fix hint: ${clip.id} must have data-duration≈${frame.duration}s (frame ${frame.num} of the storyboard).`,
        snippet: clip.id,
      });
    }
  }

  if (totalDeviation > DURATION_TOTAL_ERROR || sceneFindings.length > 0) {
    findings.push({
      code: 'duration_mismatch_storyboard',
      severity: 'error',
      message:
        `Composition total duration ${compositionTotal.toFixed(2)}s diverges from the storyboard `
        + `${storyboardTotal.toFixed(2)}s (${Math.round(totalDeviation * 100)}%). The timeline, audio and `
        + `final MP4 must match the storyboard. Fix hint: each scene-N must have data-duration≈Xs `
        + `(frame N of the storyboard): ${frames.map((f) => `scene-${f.num}: start=${f.start} duration=${f.duration}s`).join('; ')}.`,
    });
    findings.push(...sceneFindings);
  } else if (totalDeviation > DURATION_TOTAL_WARN) {
    findings.push({
      code: 'duration_mismatch_storyboard',
      severity: 'warning',
      message:
        `Composition total duration ${compositionTotal.toFixed(2)}s differs from the storyboard `
        + `${storyboardTotal.toFixed(2)}s (${Math.round(totalDeviation * 100)}%) — align clip durations `
        + `with the storyboard timing table.`,
    });
  }

  return findings;
}

/** V4-04B §5: data-end consistency — start+duration must equal data-end. */
function checkClipEndConsistency(clips: ParsedClipTiming[]): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  for (const clip of clips) {
    if (clip.end === undefined || !Number.isFinite(clip.end)) continue;
    if (Math.abs(clip.start + clip.duration - clip.end) > 0.01) {
      findings.push({
        code: 'clip_timing_inconsistent',
        severity: 'warning',
        message:
          `${clip.id}: data-start(${clip.start}) + data-duration(${clip.duration}) ≠ data-end(${clip.end}) `
          + `— remove data-end or align it with start+duration.`,
        snippet: clip.id,
      });
    }
  }
  return findings;
}

// ─── V5-P3B: IDs estáveis de elementos ──────────────────────────────────────

/**
 * Forma canónica `scene-N-{type}-K` com cauda opcional de duplicação
 * `-copy-M` (V5-P1E). `type`: os 4 emitidos pelo build prompt (text|img|
 * video|audio) + aliases legados do inferElementType e reservas do registry
 * (group|grp|shape) — tolerados na validação para não partir re-edits.
 */
const STABLE_ELEMENT_ID_RE =
  /^scene-\d+-(?:text|img|image|video|footage|audio|voice|music|sfx|group|grp|shape)-\d+(?:-copy-\d+)*$/;

/** Markup sem <svg>…</svg> nem corpos de <script> (ids aí não são endereçáveis). */
function markupWithoutSvgAndScripts(source: string): string {
  return source
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

/**
 * Rule 15: ids de ELEMENTOS (não-clip) fora do esquema estável. O esquema é
 * o que o editor registry, a Assets tab e as ops de chat usam para endereçar
 * elementos deterministicamente entre rebuilds.
 */
function checkStableElementIds(source: string): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const scan = markupWithoutSvgAndScripts(source);
  const tagRe = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let flagged = 0;
  while ((m = tagRe.exec(scan)) !== null) {
    const tag = m[0];
    if (hasAttr(tag, 'data-composition-id')) continue; // root da composição
    if (classHasClip(tag)) continue; // cenas/clips são unidade da timeline
    const id = attrValue(tag, 'id');
    if (!id) continue; // sem id → não endereçável, mas legítimo (decorativo)
    if (id.startsWith('__vp')) continue; // artefactos materializados
    if (STABLE_ELEMENT_ID_RE.test(id)) continue;
    if (flagged >= 5) break;
    flagged += 1;
    findings.push({
      code: 'element_id_not_stable',
      severity: 'error',
      message:
        `Element id "${id}" does not follow the stable ID convention `
        + '`scene-N-{type}-K` (N = parent scene number; type ∈ text|img|video|audio; '
        + 'K = per-type counter restarting in each scene). Fix hint: rename to e.g. '
        + 'scene-1-text-1 / scene-2-img-1 — the element registry, Assets panel and AI '
        + 'edits address elements by these stable ids.',
      snippet: tag.slice(0, 200),
    });
  }
  return findings;
}

/**
 * Lint a HyperFrames composition HTML document.
 * Returns `{ ok: true }` when no ERROR rule is violated.
 *
 * Pass `storyboardFrames` (parsed via parseStoryboardFrames in buildStep.ts)
 * to enable the duration and scene-coverage gates.
 */
export function edgeLintHtml(
  html: string,
  options?: { storyboardFrames?: StoryboardTimingFrame[] },
): EdgeLintResult {
  const findings: EdgeLintFinding[] = [];
  const source = html ?? '';

  // Rule 1: composition root exists
  const root = findTagWithClass(source, 'composition');
  if (!root) {
    findings.push({
      code: 'missing_composition_root',
      severity: 'error',
      message:
        'No root element with class="composition" found. Wrap the video in <div class="composition" data-composition-id="main" ...>.',
    });
    // Without a root the remaining root checks are meaningless, but the
    // timeline + clip rules still apply.
  } else {
    const rootTag = root[0];
    // Rule 2: data-composition-id
    if (!hasAttr(rootTag, 'data-composition-id')) {
      findings.push({
        code: 'root_missing_composition_id',
        severity: 'error',
        message: 'Root composition is missing `data-composition-id` (use "main").',
        snippet: rootTag.slice(0, 200),
      });
    }
    // Rule 3: data-width + data-height
    if (!hasAttr(rootTag, 'data-width') || !hasAttr(rootTag, 'data-height')) {
      findings.push({
        code: 'root_missing_dimensions',
        severity: 'error',
        message:
          'Root composition is missing `data-width` or `data-height` (numeric attributes, e.g. data-width="1080" data-height="1920" — not CSS).',
        snippet: rootTag.slice(0, 200),
      });
    }
  }

  // Rule 4 (V5.27 Fase A): timeline registry — parity with the pinned CLI
  // (`hyperframes` 0.7.109). Document-level (cli.js:81810) AND per-<script>
  // (cli.js:82941-82945): every inline block creating a timeline must carry
  // WINDOW_TIMELINE_ASSIGN_PATTERN (cli.js:81717) or
  // TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN (cli.js:81715) in the SAME
  // block. The loose document-level string check (previous behavior) is what
  // let job 1700b4f4 pass the edge and hard-fail the worker lint: a bare read
  // like `(window.__timelines || {})["main"]` satisfied it.
  // `data-no-timeline` on the root exempts the document (cli.js:81808).
  const compositionId = root ? (attrValue(root[0], 'data-composition-id') || 'main') : 'main';
  const rootExempt = !!root && /(?:^|\s)data-no-timeline(?=[\s=/]|$)/i.test(root[0]);
  const unregisteredScripts = inlineScripts(source).filter(scriptCreatesUnregisteredTimeline);
  if (unregisteredScripts.length > 0) {
    for (const script of unregisteredScripts.slice(0, 3)) {
      findings.push({
        code: 'gsap_timeline_not_registered',
        severity: 'error',
        message:
          'GSAP timeline is created but never registered in `window.__timelines` inside the SAME <script> block. '
          + 'The runtime discovers timelines from that registry — an unregistered timeline never plays. '
          + `Add: window.__timelines = window.__timelines || {}; window.__timelines["${compositionId}"] = <timeline variable>;`,
        snippet: script.trim().slice(0, 200),
      });
    }
  } else if (
    !rootExempt
    && !TIMELINE_REGISTRY_INIT_PATTERN.test(source)
    && !TIMELINE_REGISTRY_ASSIGN_PATTERN.test(source)
    && !TIMELINE_REGISTRY_OBJECT_LITERAL_PATTERN.test(source)
  ) {
    findings.push({
      code: 'missing_timeline_registry',
      severity: 'error',
      message:
        'Missing `window.__timelines` registration. Register the paused GSAP timeline synchronously: '
        + `window.__timelines["${compositionId}"] = gsap.timeline({ paused: true });`,
    });
  }
  // Rule 4b (V5.27 Fase A, document-level parity with cli.js:81818-81824):
  // an assignment without ANY accepted init form fails the real lint even
  // though a document-level string check would pass.
  if (!rootExempt && TIMELINE_REGISTRY_ASSIGN_PATTERN.test(source) && !TIMELINE_REGISTRY_INIT_PATTERN.test(source)) {
    findings.push({
      code: 'timeline_registry_missing_init',
      severity: 'error',
      message:
        '`window.__timelines[…] = …` is used without initializing `window.__timelines` first. '
        + 'Add `window.__timelines = window.__timelines || {};` before any timeline assignment.',
    });
  }

  // Rule 5: timed elements must be clips (composition root exempt — the
  // real lint identifies the root by data-composition-id, so we do the same).
  const timedTagRe = /<[a-z][a-z0-9-]*\b[^>]*data-(?:start|duration)\s*=[^>]*>/gi;
  const timedTags: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = timedTagRe.exec(source)) !== null) timedTags.push(m[0]);

  let flagged = 0;
  for (const tag of timedTags) {
    if (hasAttr(tag, 'data-composition-id')) continue; // exempt composition root(s)
    if (classHasClip(tag)) continue;
    if (flagged >= 5) break;
    flagged += 1;
    findings.push({
      code: 'timed_element_missing_clip_class',
      severity: 'error',
      message:
        'Element has data-start/data-duration but no class="clip" — it would stay visible for the whole composition. Add class="clip".',
      snippet: tag.slice(0, 200),
    });
  }

  // Rule 10 (V4-3f.17): timed clips must carry data-track-index (the track
  // model is what the timeline editor + track-density lint rely on).
  let trackFlagged = 0;
  for (const tag of timedTags) {
    if (hasAttr(tag, 'data-composition-id')) continue;
    if (!classHasClip(tag)) continue; // covered by rule 5 above
    if (hasAttr(tag, 'data-track-index')) continue;
    if (trackFlagged >= 5) break;
    trackFlagged += 1;
    findings.push({
      code: 'missing_data_track_index',
      severity: 'error',
      message:
        'Timed clip is missing `data-track-index` (numeric attribute, e.g. data-track-index="0" — scenes sequenced on one track).',
      snippet: tag.slice(0, 200),
    });
  }

  // Rule 6 (V4-3f.17): GSAP tweens must not animate layout properties —
  // the worker's real lint fails them as gsap_non_transform_motion.
  for (const script of inlineScripts(source)) {
    for (const call of findNonTransformMotion(script)) {
      findings.push({
        code: 'gsap_non_transform_motion',
        severity: 'error',
        message:
          `GSAP tween uses layout propert${call.props.length === 1 ? 'y' : 'ies'} that snap to integer device pixels: ${call.props.join(', ')}. `
          + 'Use transform equivalents instead (left→x, top→y, width/height→scale).',
        snippet: call.snippet,
      });
    }
  }

  // Rule 7 (V4-3f.17): duplicated media entries (same src + timing) confuse
  // the framework's media discovery — flag as warning.
  const mediaTagRe = /<(img|video|audio)\b[^>]*>/gi;
  const mediaSeen = new Map<string, string>();
  let mm: RegExpExecArray | null;
  while ((mm = mediaTagRe.exec(source)) !== null) {
    const tag = mm[0];
    const key = `${mm[1]}|${attrValue(tag, 'src')}|${attrValue(tag, 'data-start')}|${attrValue(tag, 'data-duration')}`;
    const first = mediaSeen.get(key);
    if (first) {
      findings.push({
        code: 'duplicate_media_discovery_risk',
        severity: 'warning',
        message:
          'Duplicate media element (same src + data-start + data-duration) — remove the duplicate or give each instance distinct timing.',
        snippet: tag.slice(0, 200),
      });
    } else {
      mediaSeen.set(key, tag);
    }
  }

  // Rule 8 (V4-3f.17): track density — more than 4 clips on one track means
  // the composition should use multiple tracks or sub-compositions.
  const perTrack = new Map<string, number>();
  for (const tag of timedTags) {
    if (!classHasClip(tag) || hasAttr(tag, 'data-composition-id')) continue;
    const track = attrValue(tag, 'data-track-index') || '(none)';
    perTrack.set(track, (perTrack.get(track) ?? 0) + 1);
  }
  for (const [track, count] of perTrack) {
    if (count > 4) {
      findings.push({
        code: 'timeline_track_too_dense',
        severity: 'warning',
        message:
          `Track ${track} holds ${count} timed clips (max 4) — split scenes across tracks or use sub-compositions (data-composition-src).`,
      });
    }
  }

  // Rule 9 (V4-3f.17): monolithic compositions are hard to validate/patch.
  const lineCount = source.split('\n').length;
  if (lineCount > 250) {
    findings.push({
      code: 'composition_file_too_large',
      severity: 'warning',
      message:
        `Composition is ${lineCount} lines (max ~250) — trim markup, use sub-compositions, and keep styling in classes/inline shorthand.`,
    });
  }

  // Rule 11 (V4-3f.17 / hyperframes 0.7.109 — V5.27 Fase B parity with
  // cli.js:84697-84715): used ∉ (declared ∪ FONT_ALIAS_KEYS2 ∪ Google-link)
  // → error. `local()` and `url()` satisfy this rule equally (cli.js:84712);
  // case-insensitive on both sides.
  const families = collectFontFamilies(source);
  if (families.size > 0) {
    const { faces, googleFonts } = declaredFontFamilies(source);
    for (const family of families) {
      if (faces.has(family) || CLI_FONT_ALIAS_KEYS.has(family) || googleFonts.has(family.replace(/\+/g, ' '))) continue;
      findings.push({
        code: 'font_family_without_font_face',
        severity: 'error',
        message:
          `Font family used without @font-face declaration: ${family}. These are not in the auto-resolved font list, so the renderer cannot supply them automatically. Add @font-face { font-family: '${family}'; src: local('${family}'); } in <style>.`,
      });
    }
  }

  // Rule 11b (V5.27 Fase B): `unresolvable_font_family` — policy on top of
  // CLI parity. A `local()`-only @font-face (including the one
  // `repairFontFaces` injects above) satisfies the CLI lint but still renders
  // with silent fallback when the renderer ships no such font — the exact
  // "incorrect typography" the lint message promises to prevent. Families
  // outside every offline-resolvable set therefore fail HERE, so the build
  // retry loop swaps them for renderer-bundled substitutes (via
  // `createEdgeLintRunner` → `buildRetryMessage`, no buildStep change needed:
  // error findings flow into the retry prompt automatically).
  if (families.size > 0) {
    const { urlFaces, googleFonts } = declaredFontFamilies(source);
    for (const family of families) {
      if (CLI_FONT_ALIAS_KEYS.has(family)) continue;
      if (urlFaces.has(family)) continue;
      if (googleFonts.has(family.replace(/\+/g, ' '))) continue;
      findings.push({
        code: 'unresolvable_font_family',
        severity: 'error',
        message:
          `Font family "${family}" cannot be resolved offline: it is not renderer-bundled, has no @font-face with a real src: url(...) and is not loaded from Google Fonts — the MP4 would silently fall back to a generic font. `
          + 'Fix hint: use a bundled family instead (sans: Inter, Montserrat, Poppins; serif: Playfair Display, EB Garamond; mono: Space Mono, JetBrains Mono, IBM Plex Mono, Source Code Pro) '
          + "or declare @font-face with the captured src: url('capture/assets/fonts/<family>.woff2').",
      });
    }
  }

  // Rule 12 (V4-3f.17): runtime script references must be present — the
  // worker vendors them offline, but their absence means the LLM dropped the
  // mandatory <head> scripts.
  if (!/<script\b[^>]*src="[^"]*gsap[^"]*"/i.test(source)) {
    findings.push({
      code: 'missing_gsap_script',
      severity: 'error',
      message:
        'Missing GSAP runtime script tag: <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>.',
    });
  }
  if (!/<script\b[^>]*src="[^"]*hyperframes[^"]*"/i.test(source)) {
    findings.push({
      code: 'missing_hyperframes_script',
      severity: 'error',
      message:
        'Missing HyperFrames runtime script tag: <script src="https://cdn.jsdelivr.net/npm/@heygen/hyperframes@0.7.109/dist/hyperframes.min.js"></script>.',
    });
  }

  // Rule 13/14 (V4-04B): storyboard duration gate + data-end consistency.
  const clipTimings = parseClipTimings(source);
  findings.push(...checkClipEndConsistency(clipTimings));
  const storyboardFrames = options?.storyboardFrames;
  if (Array.isArray(storyboardFrames) && storyboardFrames.length > 0) {
    findings.push(...checkDurationMismatch(source, storyboardFrames));
    findings.push(...checkStoryboardSceneCoverage(source, storyboardFrames));
  }

  // Rule 15 (V5-P3B): stable element IDs.
  findings.push(...checkStableElementIds(source));

  // Rule 17 (V5.12 F10): minimum typography scale check.
  findings.push(...checkTypographyScale(source));

  // Rule 18 (V5.21 Fase H): GSAP tween selectors must resolve to an element.
  findings.push(...checkGsapTargetsResolve(source));

  // Rule 24 (V5_28): favicon/icon hotlinks — error (worker 422 pre-lint).
  findings.push(...checkIconHotlinks(source));

  // Rule 25 (V5_29 Fase D): background budget — warn-only, never fails.
  findings.push(...checkBackgroundBudget(source));

  // Rule 26 (V5_32 Fase B): assinatura path↔token dos media de captura —
  // error (o worker responde 422 MEDIA_VALIDATION_FAILED sem chegar ao lint).
  findings.push(...checkSignedMediaUrls(source));

  // Rules 19–23 (V5.22 Fase H2): visual-legibility pre-commit. Warn-first:
  // they only become errors with STRICT_VISUAL_LINT=1 (explicit opt-in),
  // so false positives never block a build by default.
  // V5_26: as regras 19-22 partilham UMA passagem de sceneSlices — antes eram
  // 4 tokenizações completas do documento por lint run (o custo de CPU
  // dominante do lint em composições de ~220KB; teto da plataforma: 2s por
  // request, STATE_CURRENT §26.1).
  const slices = sceneSlices(source);
  findings.push(...checkTextAboveScrimOnSlices(slices));
  findings.push(...checkScrimCoverageOnSlices(slices));
  findings.push(...checkCaptionFillOnSlices(slices, rootCanvasHeight(source)));
  findings.push(...checkT0VisibilityOnSlices(slices));
  findings.push(...checkOpacityFromToAbsolute(source));

  const hasErrors = findings.some((f) => f.severity === 'error');
  return { ok: !hasErrors, findings };
}

/**
 * Rule 17 (V5.12 F10): Typography scale check.
 * In full-canvas renders (1080p width or height), font-size < 18px on text elements is
 * unreadable on mobile/video displays. Warns the LLM so it uses legible font sizes (24px+).
 */
function checkTypographyScale(source: string): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const tagRe = /<(?:h[1-6]|p|span|div)\b[^>]*style="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(source)) !== null) {
    const style = m[1];
    const fontMatch = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    if (fontMatch) {
      const px = parseFloat(fontMatch[1]);
      if (Number.isFinite(px) && px > 0 && px < 18) {
        findings.push({
          code: 'typography_font_too_small',
          severity: 'warning',
          message: `Element uses font-size: ${px}px which is too small for video render. Use at least 24px for body text and 48px+ for headings.`,
          snippet: m[0].slice(0, 100),
        });
        if (findings.length >= 3) break;
      }
    }
  }
  return findings;
}

/**
 * Rule 18 (V5.21 Fase H, §2.7/§3.8): orphan-tween prevention.
 *
 * A GSAP tween call (`.fromTo`/`.from`/`.to`/`.set` whose args carry tween
 * vars) whose FIRST argument is a string selector must resolve to an
 * element: the `#scene-5-tick` incident was a legacy inline tween whose
 * element no longer existed (GSAP warns `target not found` at runtime while
 * the materialized data-anim appliers skip silently).
 *
 * Regex-side mirror of `lintGsapTargets` in
 * `vp-hyperframes-worker/window-lint.js` (no DOM on the edge — only `#id`
 * and `.class` tokens are verifiable; tag/attribute/pseudo parts of a
 * compound selector cannot be proven absent by regex and are ignored).
 * Warn-only by design: feeds the retry prompt, never fails the lint.
 */
const GSAP_TARGET_FINDING_CAP = 5;

/**
 * Tween-vars keys proving a call is a GSAP tween (vs `Map.set`, …). MUST
 * stay in sync with `TWEEN_VARS_RE` in `window-lint.js` (Fase H parity).
 */
const EDGE_TWEEN_VARS_RE =
  /\b(duration|ease|delay|opacity|x|y|scale|rotation|repeat|stagger|paused|onComplete|onUpdate|onStart|startAt|yoyo|repeatDelay|motionPath|scrollTrigger|keyframes)\s*:/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when some tag carries exactly `id="<id>"` (data-hf-id excluded). */
function hasElementId(source: string, id: string): boolean {
  const re = new RegExp(`(?:\\s|^)id\\s*=\\s*["']${escapeRegExp(id)}["']`);
  return re.test(source);
}

/** True when some tag's class list contains `<cls>` as a whole token. */
function hasClassToken(source: string, cls: string): boolean {
  const re = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const tokens = (m[1] ?? m[2] ?? '').split(/\s+/).filter(Boolean);
    if (tokens.includes(cls)) return true;
  }
  return false;
}

function checkGsapTargetsResolve(source: string): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const seen = new Set<string>();
  for (const script of inlineScripts(source)) {
    for (const { callStart, argsStart, end } of tweenCallSpans(script)) {
      const args = script.slice(argsStart, Math.max(argsStart, end - 1));
      const first = args.match(/^\s*(['"])((?:\\\1|(?!\1)[\s\S])*)\1/);
      if (!first) continue; // element ref / variable — not a selector
      if (!EDGE_TWEEN_VARS_RE.test(args)) continue; // not a tween (Map.set et al.)
      const rawSelector = first[2];
      for (const part of rawSelector.split(',')) {
        const sel = part.trim();
        if (!sel || seen.has(sel)) continue;
        seen.add(sel);
        const ids = [...sel.matchAll(/#([\w-]+)/g)]
          .map((m) => m[1])
          .filter((t) => !/^\d+$/.test(t));
        const classes = [...sel.matchAll(/\.([\w-]+)/g)]
          .map((m) => m[1])
          .filter((t) => !/^\d+$/.test(t));
        if (ids.length === 0 && classes.length === 0) continue; // not verifiable by regex
        const missingId = ids.find((id) => !hasElementId(source, id));
        const missingClass = missingId === undefined
          ? classes.find((cls) => !hasClassToken(source, cls))
          : undefined;
        const missing = missingId !== undefined ? `#${missingId}` : missingClass !== undefined ? `.${missingClass}` : null;
        if (missing && findings.length < GSAP_TARGET_FINDING_CAP) {
          findings.push({
            code: 'gsap_target_missing',
            severity: 'warning',
            message:
              `GSAP tween selector "${sel}" matches no element (${missing} not found) — GSAP logs "target not found" and skips it. `
              + 'Fix hint: restore the element with this id or re-point the tween at the current id.',
            snippet: script.slice(callStart, end).trim().slice(0, 160),
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Rule 24 (V5_28, incidente 422 `7f37f5b5`): favicon/icon hotlinks as scene
 * media. The worker pre-stages EVERY external <img>/<video>/<audio> src
 * (`prestageExternalMedia`, media-preloader.js) and a single failed download
 * rejects the whole job with 422 MEDIA_VALIDATION_FAILED — before lint, hence
 * invisible to the retry loop until this edge rule flags it HERE (error, so
 * `createEdgeLintRunner` → `buildRetryMessage` feeds the LLM automatically).
 *
 * Conservative by design: only well-known icon file markers match
 * (favicon.ico, apple-touch-icon, apple-icon, android-chrome, mstile,
 * safari-pinned-tab). Captured assets
 * (`…/storage/v1/object/…/captures/…/asset-N`), BGM library URLs and data:
 * URIs never match. Match runs on the URL PATH (before `?`/`#`) so signed
 * query tokens cannot cause false positives — nor hide an icon filename.
 */
const ICON_HOTLINK_PATH_RE =
  /favicon|apple-touch-icon|apple-icon|android-chrome|mstile|safari-pinned-tab|\.ico(?:$|[?#])/i;

const MEDIA_HOTLINK_FINDING_CAP = 5;

function checkIconHotlinks(source: string): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const mediaTagRe = /<(img|video|audio)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = mediaTagRe.exec(source)) !== null) {
    const tag = m[0];
    const src = attrValue(tag, 'src');
    if (!src || !/^https?:\/\//i.test(src)) continue; // local/relative/data/blob — worker skips
    const path = src.split(/[?#]/, 1)[0];
    if (!ICON_HOTLINK_PATH_RE.test(path)) continue;
    if (findings.length >= MEDIA_HOTLINK_FINDING_CAP) break;
    findings.push({
      code: 'favicon_icon_hotlink',
      severity: 'error',
      message:
        `Media element hotlinks a favicon/icon file (${src.slice(0, 120)}). Brand sites bot-protect these files `
        + '(HTTP 403 HTML instead of image bytes) and the worker rejects the whole job with 422 MEDIA_VALIDATION_FAILED. '
        + 'Fix hint: use the captured `logo` asset URL from the "Real captured assets" section (or omit the logo) — never favicon.ico / apple-touch-icon / apple-icon URLs.',
      snippet: tag.slice(0, 200),
    });
  }
  return findings;
}

/**
 * Rule 25 (V5_29 Fase D): `background_budget` — max ONE background plate per video.
 *
 * A placa de fundo é um <img>/<video> full-bleed: `inset:0` + `object-fit:cover`
 * (ou `position:absolute` 100%×100% + cover). Conta as placas sem scrim irmão
 * de marca na mesma cena (marcador `SCRIM_MARKER_RE`); sem fatias de cena,
 * o documento inteiro é uma fatia. Warn-only: alimenta o retry loop, nunca
 * falha o lint (decisão 9: sites abstratos legítimos usam `lifestyle`).
 */
function isFullBleedPlate(tag: string): boolean {
  const name = tagNameOf(tag).toLowerCase();
  if (name !== 'img' && name !== 'video') return false;
  const style = attrValue(tag, 'style');
  if (!style) return false;
  if (!/object-fit\s*:\s*cover/i.test(style)) return false;
  if (/inset\s*:\s*0/i.test(style)) return true;
  return /position\s*:\s*absolute/i.test(style)
    && /width\s*:\s*100%/i.test(style)
    && /height\s*:\s*100%/i.test(style);
}

export function checkBackgroundBudget(source: string): EdgeLintFinding[] {
  const html = source ?? '';
  const slices = sceneSlices(html);
  const fullBleedTotal: string[] = [];
  const unscrimmed: string[] = [];

  if (slices.length === 0) {
    const tags = innerTags(html);
    const hasScrim = tags.some((t) => tagHasMarker(t, SCRIM_MARKER_RE));
    for (const tag of tags) {
      if (!isFullBleedPlate(tag)) continue;
      fullBleedTotal.push(tag);
      if (!hasScrim) unscrimmed.push(tag);
    }
  } else {
    for (const slice of slices) {
      const tags = innerTags(slice.innerHtml);
      const hasScrim = tags.some((t) => tagHasMarker(t, SCRIM_MARKER_RE));
      for (const tag of tags) {
        if (!isFullBleedPlate(tag)) continue;
        fullBleedTotal.push(tag);
        if (!hasScrim) unscrimmed.push(tag);
      }
    }
  }

  if (fullBleedTotal.length <= 1) return [];
  return [{
    code: 'background_budget',
    severity: 'warning',
    message:
      `${fullBleedTotal.length} full-bleed photographic plates found (max ONE background plate per video; `
      + `${unscrimmed.length} without a brand-tinted scrim sibling). `
      + 'Fix hint: keep a single background plate (relegate the rest to device_mockup or drop them) and give the '
      + 'photographic plate a brand-tinted scrim (>=80%, >=85% over photos) instead of a white/neutral wash.',
    snippet: fullBleedTotal[0].slice(0, 200),
  }];
}

/**
 * Rule 26 (V5_32 Fase B, incidente 422 `218b1071`): a URL assinada de um asset
 * de captura tem de autorizar exatamente o objeto do seu path. Em 2026-09-18 o
 * LLM transcreveu o path de `asset-5` com o token de `asset-4` (dois URLs quase
 * idênticos, tokens de ~300 chars): o worker respondeu 422
 * `MEDIA_VALIDATION_FAILED` no pre-stage de media, ANTES do lint — o erro era
 * invisível ao retry loop. Esta regra marca a classe no edge como `error`, para
 * o `createEdgeLintRunner` → `buildRetryMessage` alimentar o LLM e para o build
 * falhar antes de gastar o round-trip contra o worker. A canonicalização por
 * path (Fase A) repara primeiro; o que sobrar é uma inconsistência real.
 *
 * Conservadora por desenho: só `src` de `<img|video|audio|source>` que sejam
 * URLs das buckets de captura (`video-assets`/`video-screenshots`). URLs
 * externas, BGM do worker, `data:`/relativos e `video-artifacts` (VO track já
 * assinada na injeção, pós-lint) nunca são flaggados. Cap 5, como a regra 24.
 */
const MEDIA_SIGNED_URL_FINDING_CAP = 5;

export function checkSignedMediaUrls(source: string): EdgeLintFinding[] {
  const captureBuckets = CAPTURE_MEDIA_BUCKETS as readonly string[];
  const findings: EdgeLintFinding[] = [];
  for (const entry of collectMediaSrcs(source)) {
    const parsed = parseStorageUrl(entry.src);
    if (!parsed || !captureBuckets.includes(parsed.bucket)) continue;
    const audit = auditSignedMediaUrl(entry.src);
    if (audit.ok === true) continue;
    if (findings.length >= MEDIA_SIGNED_URL_FINDING_CAP) break;
    const cause = audit.code === 'path_token_mismatch'
      ? `the token authorizes "${audit.claimedPath}" instead of this path`
      : audit.code === 'expired'
        ? 'the signed token is expired'
        : 'the signed token is missing or unreadable';
    findings.push({
      code: 'media_signed_url_inconsistent',
      severity: 'error',
      message:
        `Capture media URL signature is inconsistent (${audit.code}) for "…/${parsed.path}": ${cause}. `
        + 'The worker pre-stages every media src and rejects the whole job with 422 MEDIA_VALIDATION_FAILED when the '
        + 'signature does not authorize the object. Fix hint: emit each `src` with the signed URL of THAT SAME captured '
        + "asset — never reuse another asset's URL/token (the server re-signs by path before dispatch).",
      snippet: entry.src.slice(0, 200),
    });
  }
  return findings;
}

/**
 * Rules 19–23 (V5.22 Fase H2): visual-legibility pre-commit checks.
 *
 * Pure regex + bracket-scan detectors (no JS parser, no DOM — same budget as
 * the existing rules). Every check is conservative: unparseable markup is
 * SKIPPED silently (anti-false-positive), findings are capped at 5.
 *
 * V5.22 follow-up H2 (promoção por regra, medida em golden fixtures com
 * zero FPs + `edgeLint` 42/42 sem regressão):
 * - Regras 19–21 (`text_above_scrim`, `scrim_coverage`, `caption_fill`):
 *   `warning` por defeito; `error` só com `STRICT_VISUAL_LINT=1`
 *   (decisões criativas — scrim/z-index/caption exigem LLM, nunca fail hard).
 * - Regras 22–23 (`t0_visibility`, `opacity_fromto_absolute`): `error` por
 *   defeito (bugs determinísticos — reparo seguro ou hint acionável; o retry
 *   do build usa o `MAX_BUILD_RETRIES` existente, sem aumento; fallback
 *   continua limpo). Opt-out explícito via `strict: false` → `warning`.
 * `gsap_target_missing` (regra 18) permanece warn-only intocado.
 */

/** `STRICT_VISUAL_LINT=1|true|yes|on` promotes rules 19–21 to errors. Default: warn. */
export function resolveStrictVisualLint(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  try {
    if (typeof Deno !== 'undefined') {
      const raw = (Deno.env.get('STRICT_VISUAL_LINT') ?? '').trim().toLowerCase();
      if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
      return false;
    }
  } catch {
    // Node/vitest without Deno — fall through to the default.
  }
  return false;
}

type VisualSeverity = 'error' | 'warning';

function visualSeverity(explicit?: boolean): VisualSeverity {
  return resolveStrictVisualLint(explicit) ? 'error' : 'warning';
}

/**
 * V5.22 follow-up H2: severidade promovida das regras 22–23 — `error` por
 * defeito, `warning` só com opt-out explícito (`strict: false`, usado pelo
 * loop de rewrite que consome warnings). `strict: true` ou ausente → `error`.
 */
function promotedSeverity(explicit?: boolean): VisualSeverity {
  return explicit === false ? 'warning' : 'error';
}

/** class|id|data-* marker of a scrim/overlay/plate layer. */
const SCRIM_MARKER_RE = /scrim|overlay|plate|shade|veil|\bdim\b|backdrop|gradient-scrim|data-scrim/i;
/** class|id|data-* marker of a caption skin layer. */
const CAPTION_MARKER_RE = /caption-skin|caption-text|caption|data-caption|lower-third|legenda/i;
/** Stable text-element id (`scene-N-text-K[-copy-M]`) or a bare text tag name. */
const STABLE_TEXT_ID_RE = /^scene-\d+-text-\d+(?:-copy-\d+)*$/;
const TEXT_TAG_RE = /^(h[1-6]|p|span)$/i;

function tagHasMarker(tag: string, re: RegExp): boolean {
  const cls = attrValue(tag, 'class');
  const id = attrValue(tag, 'id');
  return re.test(cls) || re.test(id) || re.test(tag);
}

/** Numeric `z-index` from an inline style (null when absent/unparseable). */
function parseZIndex(tag: string): number | null {
  const style = attrValue(tag, 'style');
  if (!style) return null;
  const m = style.match(/z-index\s*:\s*(-?\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Inline `opacity: N` (null when absent/unparseable). rgba/hex/gradient alpha stays a validator concern, not a number. */
function parseInlineOpacity(tag: string): number | null {
  const style = attrValue(tag, 'style');
  if (!style) return null;
  const m = style.match(/opacity\s*:\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseStylePercent(style: string, prop: string): number | null {
  const m = style.match(new RegExp(`${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'i'));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseStylePx(style: string, prop: string): number | null {
  const m = style.match(new RegExp(`${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*px`, 'i'));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Root canvas height (data-height) for bottom-safe math; null when unknown. */
function rootCanvasHeight(source: string): number | null {
  const root = findTagWithClass(source, 'composition');
  if (!root) return null;
  const h = parseFloat(attrValue(root[0], 'data-height'));
  return Number.isFinite(h) && h > 0 ? h : null;
}

/**
 * Slice the composition into per-scene windows: every root-owned `.clip`
 * with `id="scene-N"` contributes its inner markup. Clips in nested
 * sub-compositions are ignored (same ownership rule as rule 16).
 */
interface SceneSlice {
  sceneId: string;
  num: number;
  innerHtml: string;
}

function sceneSlices(source: string): SceneSlice[] {
  const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const tagRe = /<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  const slices: SceneSlice[] = [];
  let current: { sceneId: string; num: number; depth: number; inner: string[] } | null = null;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(markup)) !== null) {
    const [full, closing, tagNameRaw, attrs] = m;
    const tagName = tagNameRaw.toLowerCase();
    const isClosing = closing === '/';
    const selfClosing = /\/\s*>$/.test(full) || VOID_HTML_TAGS.has(tagName);
    if (!isClosing && !current) {
      const clsMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
      const cls = clsMatch?.[1] ?? '';
      const idMatch = attrs.match(/\bid\s*=\s*"([^"]*)"/i);
      const id = idMatch?.[1] ?? '';
      const clipMatch = /(?:^|\s)clip(?:\s|$)/.test(cls);
      const sceneMatch = /^scene-(\d+)$/.exec(id);
      if (clipMatch && sceneMatch && !/\bdata-composition-id\s*=/i.test(full)) {
        current = { sceneId: id, num: parseInt(sceneMatch[1], 10), depth: 1, inner: [] };
        continue;
      }
    }
    if (current) {
      if (!isClosing && !selfClosing) current.depth += 1;
      if (!isClosing || tagName !== 'div') current.inner.push(full);
      else if (current.depth > 1) current.inner.push(full);
      if (isClosing && tagName === 'div') {
        current.depth -= 1;
        if (current.depth <= 0) {
          slices.push({ sceneId: current.sceneId, num: current.num, innerHtml: current.inner.join('') });
          current = null;
        }
      }
    }
  }
  return slices;
}

function innerTags(innerHtml: string): string[] {
  const out: string[] = [];
  const tagRe = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(innerHtml)) !== null) out.push(m[0]);
  return out;
}

function tagNameOf(tag: string): string {
  return tag.match(/^<([a-z][a-z0-9-]*)/i)?.[1] ?? '';
}

function isTextLayer(tag: string): boolean {
  const id = attrValue(tag, 'id');
  if (id && STABLE_TEXT_ID_RE.test(id)) return true;
  const name = tagNameOf(tag);
  if (TEXT_TAG_RE.test(name)) return true;
  if (/^(h[1-6]|p|span)$/i.test(name) && !/\bdata-composition-id\s*=/i.test(tag)) {
    // Bare text tags inside a scene slice are text layers for the H1 rule.
    return true;
  }
  return false;
}

/**
 * Rule 19 — `text_above_scrim`: every text layer with an explicit z-index
 * must sit strictly above every marked scrim/overlay/plate of the same
 * scene. Text without an explicit z-index is skipped (natural DOM stacking
 * cannot be proven by regex). Only fires when at least one explicit scrim
 * exists in the slice (no FP on decorative gradients).
 */
export function checkTextAboveScrim(source: string, opts?: { strict?: boolean }): EdgeLintFinding[] {
  return checkTextAboveScrimOnSlices(sceneSlices(source), opts);
}

/**
 * Rule 19 sobre fatias pré-calculadas — `edgeLintHtml` partilha UMA passagem
 * de `sceneSlices` pelas regras 19-22 (V5_26: eram 4 tokenizações completas
 * do documento por lint run; ver STATE_CURRENT §26.1).
 */
function checkTextAboveScrimOnSlices(slices: SceneSlice[], opts?: { strict?: boolean }): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const severity = visualSeverity(opts?.strict);
  for (const slice of slices) {
    const tags = innerTags(slice.innerHtml);
    const scrimTags = tags.filter((t) => tagHasMarker(t, SCRIM_MARKER_RE));
    if (scrimTags.length === 0) continue;
    const explicitScrims = scrimTags
      .map((t) => ({ tag: t, z: parseZIndex(t) }))
      .filter((s): s is { tag: string; z: number } => s.z !== null);
    if (explicitScrims.length === 0) continue;
    const maxScrimZ = Math.max(...explicitScrims.map((s) => s.z));
    for (const tag of tags) {
      if (!isTextLayer(tag)) continue;
      const z = parseZIndex(tag);
      if (z === null || z > maxScrimZ) continue;
      if (findings.length >= 5) break;
      const textId = attrValue(tag, 'id') || tagNameOf(tag);
      findings.push({
        code: 'text_above_scrim',
        severity,
        message:
          `${slice.sceneId}: #${textId} (z=${z}) at/below scrim (z=${maxScrimZ}). `
          + 'Fix hint: text z-index strictly greater than any scrim/overlay/plate in the same scene.',
        snippet: tag.slice(0, 200),
      });
    }
    if (findings.length >= 5) break;
  }
  return findings;
}

/**
 * Rule 20 — `scrim_coverage`: a marked scrim with parseable opacity/coverage
 * below >=80% (>=85% over photographic plates) or coverage < 80% fails.
 * Unparseable opacity/coverage is skipped silently (anti-FP).
 */
export function checkScrimCoverage(source: string, opts?: { strict?: boolean }): EdgeLintFinding[] {
  return checkScrimCoverageOnSlices(sceneSlices(source), opts);
}

/** Rule 20 sobre fatias pré-calculadas (partilha V5_26 — ver regra 19). */
function checkScrimCoverageOnSlices(slices: SceneSlice[], opts?: { strict?: boolean }): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const severity = visualSeverity(opts?.strict);
  for (const slice of slices) {
    const hasPhoto = /<(img|video)\b/i.test(slice.innerHtml);
    const threshold = hasPhoto ? 0.85 : 0.8;
    for (const tag of innerTags(slice.innerHtml)) {
      if (!tagHasMarker(tag, SCRIM_MARKER_RE)) continue;
      const op = parseInlineOpacity(tag);
      if (op === null) continue; // cannot prove — skip (rgba/gradient alpha is H1 prompt territory)
      const style = attrValue(tag, 'style');
      const insetZero = /inset\s*:\s*0/i.test(style);
      const wPct = parseStylePercent(style, 'width');
      const cover = insetZero ? 100 : wPct;
      const lowOpacity = op < threshold;
      const lowCover = cover !== null && cover < 80;
      if (!lowOpacity && !lowCover) continue;
      if (findings.length >= 5) break;
      findings.push({
        code: 'scrim_coverage',
        severity,
        message:
          `${slice.sceneId}: scrim opacity ${op} < ${threshold.toFixed(2)}${hasPhoto ? ' (photo plate → 0.85)' : ''}`
          + `${lowCover ? `, coverage ${cover}% < 80%` : ''}. `
          + 'Fix hint: scrim behind text MUST be >=80% (>=85% over photographic plates) and cover the textbox; either swap src or add scrim.',
        snippet: tag.slice(0, 200),
      });
    }
    if (findings.length >= 5) break;
  }
  return findings;
}

/**
 * Rule 21 — `caption_fill`: a marked caption skin with parseable fill < 90%
 * or outside the bottom-safe band fails. Scenes without a caption marker are
 * skipped; unparseable geometry is skipped silently.
 */
export function checkCaptionFill(source: string, opts?: { strict?: boolean }): EdgeLintFinding[] {
  return checkCaptionFillOnSlices(sceneSlices(source), rootCanvasHeight(source), opts);
}

/** Rule 21 sobre fatias pré-calculadas (partilha V5_26 — ver regra 19). */
function checkCaptionFillOnSlices(slices: SceneSlice[], canvasH: number | null, opts?: { strict?: boolean }): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const severity = visualSeverity(opts?.strict);
  for (const slice of slices) {
    for (const tag of innerTags(slice.innerHtml)) {
      if (!tagHasMarker(tag, CAPTION_MARKER_RE)) continue;
      const style = attrValue(tag, 'style');
      const fillsFull = /inset-inline\s*:\s*0/i.test(style) || (/left\s*:\s*0/i.test(style) && /right\s*:\s*0/i.test(style));
      const wPct = parseStylePercent(style, 'width');
      const fill = fillsFull ? 100 : wPct;
      if (fill === null) continue; // unparseable width — skip
      const bottomPct = parseStylePercent(style, 'bottom');
      const bottomPx = parseStylePx(style, 'bottom');
      let bottomSafe = true;
      if (bottomPx !== null) {
        bottomSafe = bottomPx >= 100 && bottomPx <= 200;
      } else if (bottomPct !== null && canvasH !== null) {
        const px = (bottomPct / 100) * canvasH;
        bottomSafe = px >= 100 && px <= 200;
      }
      if (fill >= 90 && bottomSafe) continue;
      if (findings.length >= 5) break;
      findings.push({
        code: 'caption_fill',
        severity,
        message:
          `${slice.sceneId}: caption fill ${fill}% < 90% or outside bottom-safe (>=120px band). `
          + 'Fix hint: caption bar fill >=90% width + bottom-safe >=120px.',
        snippet: tag.slice(0, 200),
      });
    }
    if (findings.length >= 5) break;
  }
  return findings;
}

/**
 * Rule 22 — `t0_visibility`: a text/hook layer with inline `opacity: 0` at
 * t=0 fails (the E5/H0 sampler-vs-entrance mismatch: a t≈0 sampler
 * photographs an empty hook). Elements with no opacity declaration pass
 * (transform-only entrances keep the natural visible state).
 */
export function checkT0Visibility(source: string, opts?: { strict?: boolean }): EdgeLintFinding[] {
  return checkT0VisibilityOnSlices(sceneSlices(source), opts);
}

/** Rule 22 sobre fatias pré-calculadas (partilha V5_26 — ver regra 19). */
function checkT0VisibilityOnSlices(slices: SceneSlice[], opts?: { strict?: boolean }): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  // V5.22 follow-up H2: promovida a error por defeito (ver `promotedSeverity`).
  const severity = promotedSeverity(opts?.strict);
  for (const slice of slices) {
    for (const tag of innerTags(slice.innerHtml)) {
      if (!isTextLayer(tag)) {
        // Hooks are exactly the stable text layers; nested non-text wrappers
        // with opacity:0 (e.g. fade containers) are creative intent, not t0 bugs.
        continue;
      }
      if (parseInlineOpacity(tag) !== 0) continue;
      if (findings.length >= 5) break;
      const textId = attrValue(tag, 'id') || tagNameOf(tag);
      findings.push({
        code: 't0_visibility',
        severity,
        message:
          `#${textId} has inline opacity:0 at t=0 (sampler sees empty hook). `
          + 'Fix hint: text/hook MUST be opacity:1 with entrance via transform only, OR data-anim-in without inline opacity:0.',
        snippet: tag.slice(0, 200),
      });
    }
    if (findings.length >= 5) break;
  }
  return findings;
}

/**
 * Rule 23 — `opacity_fromto_absolute`: no relative `opacity: '+=…'` tween.
 * Reuses `tweenCallSpans` + `EDGE_TWEEN_VARS_RE` (proves a GSAP tween call,
 * excludes `Map.set` et al.).
 */
export function checkOpacityFromToAbsolute(source: string, opts?: { strict?: boolean }): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  // V5.22 follow-up H2: promovida a error por defeito (ver `promotedSeverity`).
  const severity = promotedSeverity(opts?.strict);
  const relRe = /opacity\s*:\s*['"]?\s*[+-]=/;
  for (const script of inlineScripts(source)) {
    for (const { callStart, argsStart, end } of tweenCallSpans(script)) {
      const args = script.slice(argsStart, Math.max(argsStart, end - 1));
      if (!EDGE_TWEEN_VARS_RE.test(args)) continue; // not a tween (Map.set et al.)
      if (!relRe.test(args)) continue;
      if (findings.length >= 5) break;
      findings.push({
        code: 'opacity_fromto_absolute',
        severity,
        message:
          `Relative opacity tween (opacity:'+=…') — use absolute fromTo(target,{opacity:0},{opacity:1}). `
          + 'Fix hint: binary 0→1 via tl.set for arrivals, never relative +=.',
        snippet: script.slice(callStart, end).trim().slice(0, 160),
      });
    }
    if (findings.length >= 5) break;
  }
  return findings;
}

/**
 * V5.22 Fase H2: deterministic repair of the single safe case — a text layer
 * carrying BOTH `data-anim-in` and inline `opacity: 0`. The materialized
 * `fromTo` re-applies the 0 at the entrance position, so removing the inline
 * 0 restores the visible first frame without changing the animation. Without
 * `data-anim-in` the 0 may be creative intent — reported, never repaired.
 * Scrim/z-index/caption are NEVER auto-repaired (creative decisions → LLM).
 */
export function repairT0Visibility(html: string): string {
  const source = html ?? '';
  return source.replace(/<[a-z][a-z0-9-]*\b[^>]*>/gi, (tag: string) => {
    if (!/\bdata-anim-in\s*=/i.test(tag)) return tag;
    if (!/opacity\s*:\s*0(?![\d.])/i.test(tag)) return tag;
    const styleMatch = tag.match(/\bstyle\s*=\s*"([^"]*)"/i);
    if (!styleMatch) return tag;
    let style = styleMatch[1].replace(/(?:^|;)\s*opacity\s*:\s*0(?![\d.])\s*;?/i, '');
    style = style.replace(/;;+/g, ';').replace(/^\s*;+\s*|\s*;+\s*$/g, '').trim();
    if (!style) return tag.replace(/\s*\bstyle\s*=\s*"[^"]*"/i, '');
    return tag.replace(styleMatch[0], `style="${style}"`);
  });
}

/**
 * Deterministic repair of the classic heading-size trap: an `<h1>`–`<h6>`
 * inherits the browser's 2em default, NOT the wrapper's inline font-size.
 * When the heading has no inline font-size and its immediate parent declares
 * one, add explicit inherit declarations so the heading renders at the
 * authored size instead of ~2x and overlapping the next block. Headings with
 * their own font-size (inline) are untouched; no CSS parsing is attempted.
 */
export function repairHeadingInheritance(html: string): string {
  const source = html ?? '';
  if (!/<h[1-6]\b/i.test(source)) return source;
  const parentWithSize =
    /(<(?:div|section|header|main|article|aside|p|span)\b[^>]*\bstyle="[^"]*font-size\s*:[^"]*"[^>]*>)([\s\S]{0,120}?)(<h[1-6]\b)([^>]*)(>)/gi;
  return source.replace(parentWithSize, (match, parentOpen, gap, headingOpen, attrs, close) => {
    if (/\bfont-size\s*:/i.test(attrs)) return match;
    const declarations = [
      /\bfont-size\s*:/i.test(attrs) ? '' : 'font-size:inherit',
      /\bline-height\s*:/i.test(attrs) ? '' : 'line-height:inherit',
      /\bfont-weight\s*:/i.test(attrs) ? '' : 'font-weight:inherit',
    ].filter(Boolean).join(';');
    if (!declarations) return match;
    let nextAttrs = attrs;
    if (/\bstyle\s*=\s*"/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(
        /\bstyle\s*=\s*"([^"]*)"/i,
        (_style: string, value: string) => `style="${value.replace(/;\s*$/, '')};${declarations}"`,
      );
    } else {
      nextAttrs = `${nextAttrs} style="${declarations}"`;
    }
    return `${parentOpen}${gap}${headingOpen}${nextAttrs}${close}`;
  });
}

/**
 * LintRunner adapter for buildStep.ts (generateBuildHtmlOnly / runBuildStep).
 * `errors` is formatted as actionable text for the LLM retry prompt;
 * `warnings` (V4-3f.17) is surfaced separately so the retry loop can ask the
 * LLM to address them without hard-failing the build.
 *
 * The runner accepts optional storyboard timing frames. When provided, every
 * lint pass also runs the duration and scene-coverage gates, and their
 * findings flow into the retry prompt.
 */
export function createEdgeLintRunner(): {
  lint(html: string, storyboardFrames?: StoryboardTimingFrame[]): Promise<{ ok: boolean; errors: string; warnings: string }>;
} {
  const format = (list: EdgeLintFinding[]) =>
    list.map((f, i) => `${i + 1}. [${f.code}] ${f.message}${f.snippet ? `\n   offending markup: ${f.snippet}` : ''}`).join('\n');
  const lint = (html: string, storyboardFrames?: StoryboardTimingFrame[]) => {
    const result = edgeLintHtml(html, { storyboardFrames });
    const errors = format(result.findings.filter((f) => f.severity === 'error'));
    const warnings = format(result.findings.filter((f) => f.severity === 'warning'));
    return Promise.resolve({ ok: result.ok, errors, warnings });
  };
  return { lint };
}

/**
 * Deterministic repair of the most common LLM omissions:
 *  1. Root `.composition` missing `data-composition-id` → add "main".
 *  2. Root missing `data-width`/`data-height` → derive from inline style
 *     (width:1080px → data-width="1080"), defaulting to 1080x1920.
 *  3. (V5.27 Fase A) Timeline registration missing INSIDE the <script> that
 *     creates it → splice the canonical
 *     `window.__timelines["<id>"] = <timeline var>;` right after the creation
 *     statement (a new sibling block is rejected by the CLI per-script rule).
 *     Only when the document carries no timeline at all → inject a canonical
 *     self-registered block before `</body>`.
 *  4. (V5.22 Fase H2) text layer with `data-anim-in` + inline `opacity: 0`
 *     → remove the inline 0 (visible first frame; the materialized fromTo
 *     re-applies it at the entrance).
 * Elements with timing attributes but no clip class are NOT auto-repaired
 * (visibility semantics are ambiguous) — they are reported to the LLM.
 * Scrim/z-index/caption are NEVER auto-repaired (creative decisions → LLM).
 */
export function autoRepairComposition(html: string): string {
  let out = html ?? '';
  const root = findTagWithClass(out, 'composition');
  if (!root) return out;

  let rootTag = root[0];

  // 1. data-composition-id
  if (!hasAttr(rootTag, 'data-composition-id')) {
    rootTag = rootTag.replace(/>$/, ' data-composition-id="main">');
  }

  // 2. data-width / data-height (derive from inline style when present)
  const styleMatch = rootTag.match(/style="([^"]*)"/i);
  const styleCss = styleMatch ? styleMatch[1] : '';
  const cssW = styleCss.match(/width\s*:\s*(\d+)\s*px/i);
  const cssH = styleCss.match(/height\s*:\s*(\d+)\s*px/i);
  if (!hasAttr(rootTag, 'data-width')) {
    rootTag = rootTag.replace(/>$/, ` data-width="${cssW ? cssW[1] : '1080'}">`);
  }
  if (!hasAttr(rootTag, 'data-height')) {
    rootTag = rootTag.replace(/>$/, ` data-height="${cssH ? cssH[1] : '1920'}">`);
  }

  if (rootTag !== root[0]) {
    out = out.replace(root[0], () => rootTag);
  }

  // 3. timeline registry (V5.27 Fase A): register the timeline INSIDE the
  //    script that creates it (CLI per-script parity, cli.js:82941-82945).
  //    Falls back to a canonical self-registered block only when the document
  //    carries no timeline and no valid registry (a bare read is not one).
  out = repairTimelineRegistry(out, attrValue(rootTag, 'data-composition-id') || 'main');

  // 4. font-faces for used custom font families
  out = repairFontFaces(out);

  // 5. V5.22 Fase H2: visible-first-frame for data-anim-in text layers.
  out = repairT0Visibility(out);

  return out;
}

/**
 * F03.3/F03.4: gate dimensões efectivas vs HTML (sem implementar F04).
 * Verifica root + cenas + CSS + metadata iguais ao efectivo. Menção no prompt
 * ou data-width isolado não conta. Retorna findings (error quando diverge).
 */
export function checkEffectiveDimensionsGate(
  html: string,
  expected: { width: number; height: number },
  metadata?: { width?: unknown; height?: unknown } | null,
): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const src = html ?? "";
  const rootM = /<div\b[^>]*data-composition-id\s*=[^>]*>/i.exec(src);
  if (!rootM) {
    findings.push({ code: "f03_root_missing", severity: "error", message: "F03: sem root para gate de dimensões efectivas." });
    return findings;
  }
  const tag = rootM[0];
  const wM = tag.match(/\bdata-width\s*=\s*"([^"]*)"/i);
  const hM = tag.match(/\bdata-height\s*=\s*"([^"]*)"/i);
  const w = wM ? parseInt(wM[1], 10) : NaN;
  const h = hM ? parseInt(hM[1], 10) : NaN;
  if (w !== expected.width || h !== expected.height) {
    findings.push({
      code: "f03_dimensions_mismatch",
      severity: "error",
      message: `F03: root ${Number.isFinite(w) ? w : "?"}x${Number.isFinite(h) ? h : "?"} ≠ efectivo ${expected.width}x${expected.height}. Todas as cenas/CSS/metadata devem igualar o efectivo.`,
      snippet: tag.slice(0, 200),
    });
  }
  if (metadata && typeof metadata.width === "number" && typeof metadata.height === "number") {
    if (metadata.width !== expected.width || metadata.height !== expected.height) {
      findings.push({
        code: "f03_metadata_dimensions_mismatch",
        severity: "error",
        message: `F03: metadata ${metadata.width}x${metadata.height} ≠ efectivo ${expected.width}x${expected.height}.`,
      });
    }
  }
  return findings;
}

/**
 * F03.4: tri-state audit (sem enforcement final F04/worker).
 * `on` sem output real => error; `off` com output injetado => error;
 * `auto` sem decisão => warning. Chamador fornece o estado materializado.
 */
export function checkTriStateGate(args: {
  requested: { narration?: string; captions?: string; music?: string; sfx?: string };
  materialized: { hasVo: boolean; hasBgm: boolean; hasCaptions: boolean; hasSfx: boolean };
  decisions?: string[];
}): EdgeLintFinding[] {
  const out: EdgeLintFinding[] = [];
  const req = args.requested ?? {};
  const mat = args.materialized;
  if (req.narration === "on" && !mat.hasVo) {
    out.push({ code: "f03_narration_on_missing", severity: "error", message: "F03: narration:on sem VO real — exige output ou falha explícita." });
  }
  if (req.narration === "off" && mat.hasVo) {
    out.push({ code: "f03_narration_off_leaked", severity: "error", message: "F03: narration:off com VO injetado — off impede geração e remove derivados." });
  }
  if (req.music === "on" && !mat.hasBgm) {
    out.push({ code: "f03_music_on_missing", severity: "error", message: "F03: music:on sem BGM — repair ou erro explícito, nunca sucesso falso." });
  }
  if (req.music === "off" && mat.hasBgm) {
    out.push({ code: "f03_music_off_leaked", severity: "error", message: "F03: music:off com BGM — off elimina BGM." });
  }
  if (req.sfx === "on" && !mat.hasSfx) {
    out.push({ code: "f03_sfx_on_missing", severity: "error", message: "F03: sfx:on sem SFX real (SFX_NOT_SUPPORTED nesta fase) — rejeitar com erro acionável." });
  }
  if (req.captions === "off" && mat.hasCaptions) {
    out.push({ code: "f03_captions_off_leaked", severity: "error", message: "F03: captions:off com captions — off remove derivados." });
  }
  return out;
}

/**
 * F04-T04: enforce dimensões e fps no builder — valores numéricos válidos e
 * igualdade ao effective config, root/CSS canvas coerentes e bounds.
 * Retry recebe feedback estruturado esperado/observado; fallback usa as mesmas
 * dimensões. Não concluir com warnings quando o formato obrigatório diverge.
 */
export function checkF04DimensionsFpsGate(
  html: string,
  expected: { width: number; height: number; fps?: number; duration_target_seconds?: number | null },
): EdgeLintFinding[] {
  const findings: EdgeLintFinding[] = [];
  const src = html ?? '';
  const { width: ew, height: eh, fps: efps, duration_target_seconds: edur } = expected;
  if (!Number.isFinite(ew) || !Number.isFinite(eh) || ew < 16 || ew > 7680 || eh < 16 || eh > 7680) {
    findings.push({ code: 'f04_expected_dims_invalid', severity: 'error', message: `F04: expected dims inválidas ${String(ew)}x${String(eh)} (bounds [16,7680]).` });
    return findings;
  }
  const rootM = /<div\b[^>]*data-composition-id\s*=[^>]*>/i.exec(src);
  if (!rootM) {
    findings.push({ code: 'f04_root_missing', severity: 'error', message: 'F04: sem root para gate de dimensões efectivas.' });
    return findings;
  }
  const tag = rootM[0];
  const wM = tag.match(/\bdata-width\s*=\s*"([^"]*)"/i);
  const hM = tag.match(/\bdata-height\s*=\s*"([^"]*)"/i);
  const w = wM ? parseInt(wM[1], 10) : NaN;
  const h = hM ? parseInt(hM[1], 10) : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    findings.push({ code: 'f04_root_dims_nonnumeric', severity: 'error', message: `F04: root data-width/height não numéricos (observed=${wM?.[1] ?? '?'}x${hM?.[1] ?? '?'}, expected=${ew}x${eh}).` });
  } else if (w !== ew || h !== eh) {
    findings.push({ code: 'f04_dimensions_mismatch', severity: 'error', message: `F04: root ${w}x${h} ≠ efectivo ${ew}x${eh} (expected/observed). Repair explícito; fallback nas mesmas dimensões.` });
  } else {
    const styleW = tag.match(/width\s*:\s*(\d+)px/i)?.[1];
    const styleH = tag.match(/height\s*:\s*(\d+)px/i)?.[1];
    if (!styleW || !styleH || parseInt(styleW, 10) !== ew || parseInt(styleH, 10) !== eh) {
      findings.push({ code: 'f04_root_style_mismatch', severity: 'error', message: `F04: root style ${styleW ?? '?'}x${styleH ?? '?'}px ≠ efectivo ${ew}x${eh}px (root/CSS canvas coerentes).` });
    }
  }
  // Cenas: cada scene-N com style do efectivo.
  const clipRe = /<div\b[^>]*class\s*=\s*["'][^"']*\bclip\b[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  let scenes = 0;
  while ((m = clipRe.exec(src)) !== null) {
    const t = m[0];
    if (/\bdata-composition-id\s*=/i.test(t)) continue;
    const id = (t.match(/\bid\s*=\s*"([^"]*)"/i)?.[1]) ?? '';
    if (!/^scene-\d+/i.test(id) && !/\bdata-scene\s*=/i.test(t)) continue;
    scenes++;
    const sw = t.match(/width\s*:\s*(\d+)px/i)?.[1];
    const sh = t.match(/height\s*:\s*(\d+)px/i)?.[1];
    if (!sw || !sh || parseInt(sw, 10) !== ew || parseInt(sh, 10) !== eh) {
      findings.push({ code: 'f04_scene_dims_mismatch', severity: 'error', message: `F04: cena ${id || scenes} style ${sw ?? '?'}x${sh ?? '?'}px ≠ efectivo ${ew}x${eh}px.` });
    }
  }
  if (scenes === 0) findings.push({ code: 'f04_no_scenes', severity: 'error', message: 'F04: nenhuma cena scene-N para o gate de dimensões.' });
  if (efps !== undefined && (!Number.isFinite(efps) || efps < 1 || efps > 120)) {
    findings.push({ code: 'f04_fps_invalid', severity: 'error', message: `F04: fps esperado inválido ${String(efps)} (bounds [1,120]; suportado [30]).` });
  }
  if (edur !== undefined && edur !== null && (!(edur > 0) || !(edur <= 600))) {
    findings.push({ code: 'f04_duration_invalid', severity: 'error', message: `F04: duration target inválido ${String(edur)}.` });
  }
  return findings;
}

/**
 * F03.3: duration target nunca regressa a 15 silenciosamente.
 * Compara alvo persistido vs soma dos clips; ausência de alvo => error.
 */
export function checkDurationTargetGate(
  html: string,
  targetSec: number | null | undefined,
): EdgeLintFinding[] {
  if (targetSec === null || targetSec === undefined || !(targetSec > 0)) {
    return [{ code: "f03_duration_target_missing", severity: "error", message: "F03: duration target ausente — nunca assumir 15s silenciosamente." }];
  }
  const clipRe = /<div\b[^>]*class\s*=\s*["'"'"'][^"'"'"']*\bclip\b[^"'"'"']*["'"'"'][^>]*>/gi;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = clipRe.exec(html ?? "")) !== null) {
    const tag = m[0];
    if (/\bdata-composition-id\s*=/i.test(tag)) continue;
    const d = tag.match(/\bdata-duration\s*=\s*"([^"]*)"/i);
    const s = tag.match(/\bdata-start\s*=\s*"([^"]*)"/i);
    if (d) {
      const dur = parseFloat(d[1]);
      const st = s ? parseFloat(s[1]) : 0;
      if (Number.isFinite(dur) && Number.isFinite(st)) total = Math.max(total, st + dur);
    }
  }
  if (Math.abs(total - targetSec) > Math.max(0.5, targetSec * 0.1)) {
    return [{ code: "f03_duration_mismatch", severity: "error", message: `F03: soma clips ${total.toFixed(2)}s ≠ alvo ${targetSec}s (15/30/60 nunca regressam a 15).` }];
  }
  return [];
}
