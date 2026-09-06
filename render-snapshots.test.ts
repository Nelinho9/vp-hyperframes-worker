// @vitest-environment node
/**
 * render-snapshots.test.ts — V5.22 Fase H3: quality-gate render snapshots use
 * per-scene POST-ENTRANCE times (min(start + 1.5s, midpoint, end - margin)),
 * the server-side contract of `scenePostEntranceFrame` (timelineV4Model.ts).
 *
 * Why: `snapshot --frames 5` sampled uniformly INCLUDING t=0, where
 * spring-pop/fromTo entrances (~1s) had not run yet — a sampler-vs-entrance
 * mismatch (E5/H0), not a composition defect. H3 keeps 1 frame/scene
 * (max 5, temporal order) so the VLM sees what the user sees. Thumbnails
 * (overview) intentionally keep midpoints — see thumbnails.test.ts.
 */
import { describe, expect, it, afterEach } from 'vitest';

import {
  buildRenderSnapshotArgs,
  parseScenePostEntranceTimes,
  parseSceneWindows,
  renderSnapshotsLegacyFrames,
  RENDER_SNAPSHOT_END_MARGIN_S,
  RENDER_SNAPSHOT_POST_ENTRANCE_OFFSET_S,
  MAX_RENDER_SNAPSHOTS,
} from './thumbnails.js';

const HTML = `<!doctype html><html><body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="10">
  <div id="scene-1" class="clip" data-start="0" data-duration="3" data-track-index="0"></div>
  <div id="deco" class="overlay" data-start="0" data-duration="3"></div>
  <div id="scene-2" class="clip" data-start="3" data-duration="2.5" data-track-index="0">
    <div class="composition" data-composition-id="nested" data-start="0" data-duration="99">
      <div id="inner" class="clip" data-start="77" data-duration="3"></div>
    </div>
  </div>
  <div id="scene-3" class="clip" data-start="5.5" data-duration="0.006" data-track-index="0"></div>
</div>
</body></html>`;

describe('H3 constants', () => {
  it('offset 1.5s, end margin and max-5 contract', () => {
    expect(RENDER_SNAPSHOT_POST_ENTRANCE_OFFSET_S).toBe(1.5);
    expect(RENDER_SNAPSHOT_END_MARGIN_S).toBe(0.05);
    expect(MAX_RENDER_SNAPSHOTS).toBe(5);
  });
});

describe('parseSceneWindows', () => {
  it('lists root-owned scene windows in temporal order, nested ignored', () => {
    expect(parseSceneWindows(HTML)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 5.5 },
      { start: 5.5, end: 5.506 },
    ]);
  });

  it('unreadable markup → []', () => {
    expect(parseSceneWindows('<html><body><p>oi</p></body></html>')).toEqual([]);
  });
});

describe('parseScenePostEntranceTimes', () => {
  it('typical scenes: min(start+1.5, midpoint); tiny scene stays inside [start, end)', () => {
    // scene-1 (0..3): min(1.5, 1.5, 2.95) = 1.5
    // scene-2 (3..5.5): min(4.5, 4.25, 5.45) = 4.25 (midpoint wins)
    // scene-3 (5.5..5.506): midpoint 5.503, inside the window
    expect(parseScenePostEntranceTimes(HTML)).toEqual([1.5, 4.25, 5.503]);
  });

  it('30s scene samples post-entrance, not the midpoint (H3 ≠ thumbnails)', () => {
    const html = '<div data-composition-id="m">'
      + '<div id="scene-1" class="clip" data-start="0" data-duration="30"></div>'
      + '</div>';
    expect(parseScenePostEntranceTimes(html)).toEqual([1.5]);
  });

  it('sub-1.5s scene falls back to its midpoint (never overshoots)', () => {
    const html = '<div data-composition-id="m">'
      + '<div id="scene-1" class="clip" data-start="10" data-duration="1"></div>'
      + '</div>';
    // min(11.5, 10.5, 10.95) = 10.5
    expect(parseScenePostEntranceTimes(html)).toEqual([10.5]);
  });

  it('caps at 5 scenes in temporal order', () => {
    const clips = Array.from({ length: 8 }, (_, i) =>
      `<div id="scene-${i + 1}" class="clip" data-start="${i * 3}" data-duration="3"></div>`).join('');
    const times = parseScenePostEntranceTimes(`<div data-composition-id="m">${clips}</div>`);
    expect(times).toHaveLength(5);
    expect(times).toEqual([1.5, 4.5, 7.5, 10.5, 13.5]);
  });

  it('no scenes / invalid clips → [] (caller uses legacy --frames 5)', () => {
    expect(parseScenePostEntranceTimes('<html><body><p>vazio</p></body></html>')).toEqual([]);
    expect(parseScenePostEntranceTimes('')).toEqual([]);
  });

  it('times are quantized to ms', () => {
    const html = '<div data-composition-id="m">'
      + '<div id="scene-1" class="clip" data-start="0.123456" data-duration="3"></div>'
      + '</div>';
    const [t] = parseScenePostEntranceTimes(html);
    expect(t).toBe(Math.round(t * 1000) / 1000);
  });
});

describe('buildRenderSnapshotArgs', () => {
  it('canonical: --at joined, --no-end, --describe false, project dir last', () => {
    const { command, args } = buildRenderSnapshotArgs([1.5, 4.25], '/job');
    expect(command).toBe('npx');
    expect(args).toEqual([
      'hyperframes', 'snapshot',
      '--at', '1.5,4.25',
      '--no-end',
      '--describe', 'false',
      '/job',
    ]);
  });

  it('HYPERFRAMES_BIN replaces npx hyperframes', () => {
    process.env.HYPERFRAMES_BIN = '/usr/local/bin/hyperframes';
    try {
      const { command, args } = buildRenderSnapshotArgs([2], '/p');
      expect(command).toBe('/usr/local/bin/hyperframes');
      expect(args[0]).toBe('snapshot');
      expect(args).toContain('--no-end');
    } finally {
      delete process.env.HYPERFRAMES_BIN;
    }
  });
});

describe('renderSnapshotsLegacyFrames', () => {
  afterEach(() => {
    delete process.env.RENDER_SNAPSHOTS_LEGACY_FRAMES;
  });

  it('default off (post-entrance sampling)', () => {
    delete process.env.RENDER_SNAPSHOTS_LEGACY_FRAMES;
    expect(renderSnapshotsLegacyFrames()).toBe(false);
  });

  it('1 enables the legacy --frames 5 rollback', () => {
    process.env.RENDER_SNAPSHOTS_LEGACY_FRAMES = '1';
    expect(renderSnapshotsLegacyFrames()).toBe(true);
  });

  it('0/false/off/no keep post-entrance sampling', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      process.env.RENDER_SNAPSHOTS_LEGACY_FRAMES = v;
      expect(renderSnapshotsLegacyFrames()).toBe(false);
    }
  });
});
