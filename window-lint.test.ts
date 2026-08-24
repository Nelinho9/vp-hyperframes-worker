// @vitest-environment node
/**
 * window-lint.test.ts — V5-P0C §2.2: worker-side clip-window lint.
 *
 * Validates `lintClipWindows` against served composition HTML:
 * 1. Overlapping top-level clip windows → `clip_window_overlap` (error).
 * 2. Gaps between adjacent windows → `clip_window_gap` (warning).
 * 3. The composition root and nested compositions are exempt.
 * 4. Clean contiguous timelines produce zero findings.
 *
 * Doc: docs/video-engine/V5_P0C_SEEK_DETERMINISTICO.md
 */

import { describe, expect, it } from 'vitest';
import { lintClipWindows } from './window-lint.js';

function doc(clips: string): string {
  return `<!doctype html>
<html><head><title>t</title></head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="30">
${clips}
</div>
</body>
</html>`;
}

describe('lintClipWindows — V5-P0C', () => {
  it('returns [] for a clean contiguous timeline', () => {
    const html = doc(`
      <div id="scene-1" class="clip" data-start="0" data-duration="6"></div>
      <div id="scene-2" class="clip" data-start="6" data-duration="6"></div>
      <div id="scene-3" class="clip" data-start="12" data-duration="6"></div>
    `);
    expect(lintClipWindows(html)).toEqual([]);
  });

  it('flags an overlap as clip_window_overlap (error) with the selector', () => {
    const html = doc(`
      <div id="scene-1" class="clip" data-start="0" data-duration="6"></div>
      <div id="scene-2" class="clip" data-start="5.9" data-duration="6"></div>
    `);
    const findings = lintClipWindows(html);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'clip_window_overlap',
      severity: 'error',
      selector: '#scene-2',
    });
    expect(findings[0].message).toContain('scene-1');
  });

  it('flags sub-frame overlaps produced by decimal rounding', () => {
    // The B2.1 signature: durations rounded to ms drift above the grid, so
    // the previous clip's end (start + dur) exceeds the next written start.
    const html = doc(`
      <div id="a" class="clip" data-start="0" data-duration="0.334"></div>
      <div id="b" class="clip" data-start="0.333" data-duration="0.334"></div>
      <div id="c" class="clip" data-start="0.667" data-duration="0.333"></div>
    `);
    const findings = lintClipWindows(html);
    expect(findings.map((f) => f.code)).toContain('clip_window_overlap');
    expect(findings.find((f) => f.selector === '#b')?.severity).toBe('error');
  });

  it('flags a gap as clip_window_gap (warning)', () => {
    const html = doc(`
      <div id="scene-1" class="clip" data-start="0" data-duration="6"></div>
      <div id="scene-2" class="clip" data-start="7" data-duration="6"></div>
    `);
    const findings = lintClipWindows(html);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'clip_window_gap',
      severity: 'warning',
      selector: '#scene-2',
    });
  });

  it('exempts the composition root even when it carries timing attrs', () => {
    // Root has data-composition-id → never compared as a sibling clip.
    const html = doc(`
      <div id="scene-1" class="clip" data-start="0" data-duration="6"></div>
    `);
    expect(lintClipWindows(html)).toEqual([]);
  });

  it('ignores clips inside nested compositions (data-composition-id)', () => {
    const html = doc(`
      <div id="scene-1" class="clip" data-start="0" data-duration="6"></div>
      <div id="nested" class="clip" data-composition-id="nested" data-start="0" data-duration="99">
        <div id="inner-a" class="clip" data-start="0" data-duration="1"></div>
        <div id="inner-b" class="clip" data-start="50" data-duration="1"></div>
      </div>
      <div id="scene-2" class="clip" data-start="6" data-duration="6"></div>
    `);
    // inner-* windows would overlap/gap wildly; they live on their own
    // nested timeline and must not be validated against the root sequence.
    expect(lintClipWindows(html)).toEqual([]);
  });

  it('skips clips without usable numeric windows', () => {
    const html = doc(`
      <div id="no-dur" class="clip" data-start="0"></div>
      <div id="bad-num" class="clip" data-start="abc" data-duration="def"></div>
      <div id="scene-2" class="clip" data-start="0" data-duration="6"></div>
    `);
    expect(lintClipWindows(html)).toEqual([]);
  });

  it('returns [] for empty or non-string input', () => {
    expect(lintClipWindows('')).toEqual([]);
    expect(lintClipWindows(null as unknown as string)).toEqual([]);
  });
});
