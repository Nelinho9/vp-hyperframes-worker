import { describe, expect, it } from 'vitest';
import { readPatchTargetValues, patchValueMatches, readSceneStructure, applyPatchesLinkedom } from './patch-engine.js';
import { prepareComposition } from './composition-editor.js';

const HTML = `<div data-composition-id="root" data-width="1080" data-height="1920" data-duration="6">
  <div class="clip" id="s1" data-start="0" data-duration="2" style="left:10px">A</div>
  <div class="clip" id="s2" data-start="2" data-duration="3" data-transition-in="fade@400">B</div>
  <div id="title" style="font-size:16px;--el-x:30px;--el-y:40px;left:100px;top:50px">Hello</div>
  <img id="pic" src="asset://a" style="background-image:url(x.png)" />
</div>`;

describe('E01-B read-set: authored patch target values', () => {
  it('reads back every write path kind value-stably', () => {
    const values = readPatchTargetValues(HTML, [
      { selector: '#title', property: 'text' },
      { selector: '#title', property: 'size' },
      { selector: '#title', property: 'x' },
      { selector: '#title', property: 'y' },
      { selector: '#title', property: 'rotation' },
      { selector: '#title', property: 'animIn' },
      { selector: '#title', property: 'label' },
      { selector: '#title', property: 'hidden' },
      { selector: '#pic', property: 'src' },
      { selector: '#pic', property: 'background-image' },
    ]);
    expect(values.map(v => v.value)).toEqual([
      'Hello',   // textContent
      '16',      // decl with unit stripped
      '130',     // --el-x 30 + authored left 100
      '90',      // --el-y 40 + authored top 50
      '',        // rotation never authored → declaration missing
      '',        // data-anim-in absent
      '',        // data-label absent
      'false',   // data-hidden absent
      'asset://a',
      'x.png',   // url(...) unwrapped back to the patch value form
    ]);
  });

  it('write→read round-trips for decl, geom and text values', () => {
    const patched = applyPatchesLinkedom(HTML, [
      { selector: '#title', property: 'text', value: 'World' },
      { selector: '#title', property: 'size', value: '24' },
      { selector: '#title', property: 'x', value: '200' },
    ]);
    const read = readPatchTargetValues(patched.html, [
      { selector: '#title', property: 'text' },
      { selector: '#title', property: 'size' },
      { selector: '#title', property: 'x' },
    ]);
    expect(read.map(v => v.value)).toEqual(['World', '24', '200']);
  });

  it('missing elements and node ops read as null (precondition conflict / not undoable)', () => {
    const values = readPatchTargetValues(HTML, [
      { selector: '#gone', property: 'text' },
      { selector: '#title', property: 'element' },
    ]);
    expect(values[0].value).toBeNull();
    expect(values[1].value).toBeNull();
  });

  it('numeric comparison tolerates float representation, exact otherwise', () => {
    expect(patchValueMatches('340.2', '340.2')).toBe(true);
    expect(patchValueMatches('340.19999999999998863', '340.2')).toBe(true);
    // readPatchTargetValues already strips authored units. The comparator
    // must not treat incompatible wire values (including literal text) alike.
    expect(patchValueMatches('16px', '16')).toBe(false);
    expect(patchValueMatches('red', 'blue')).toBe(false);
    expect(patchValueMatches(null, 'x')).toBe(false);
  });
});

describe('E01-B read-set: scene structure', () => {
  it('reads root-owned scenes and boundary transitions in document order', () => {
    const structure = readSceneStructure(HTML);
    expect(structure.scenes).toEqual([
      { id: 's1', durationFrames: 60 },
      { id: 's2', durationFrames: 90 },
    ]);
    expect(structure.transitions).toEqual([{ id: 's2', kind: 'fade', durationMs: 400 }]);
  });
});

describe('E01-B prepareComposition preconditions and journal read-set', () => {
  it('C2 never reports success reinserting a deleted ID without its fragment', () => {
    const deleted = prepareComposition('restructure', { source_html: HTML, revision: 2,
      scenes: [{ id: 's1', durationFrames: 60 }], transitions: [] });
    expect(deleted.undoable).toBe(false);
    expect(() => prepareComposition('restructure', { source_html: deleted.html, revision: 3,
      scenes: deleted.before_scenes, transitions: deleted.before_transitions }))
      .toThrow('SCENE_FRAGMENT_UNAVAILABLE');
  });

  it('C2 checks transition read-set and reads core durations without counting the overlap twice', () => {
    const changed = prepareComposition('restructure', { source_html: HTML, revision: 2,
      scenes: [{ id: 's1', durationFrames: 90 }, { id: 's2', durationFrames: 90 }],
      transitions: [{ id: 's2', kind: 'fade', durationMs: 400 }] });
    expect(readSceneStructure(changed.html).scenes).toEqual([
      { id: 's1', durationFrames: 90 }, { id: 's2', durationFrames: 90 },
    ]);
    expect(() => prepareComposition('restructure', { source_html: changed.html, revision: 3,
      scenes: changed.before_scenes, transitions: [], expected_transitions: [] }))
      .toThrow('UNDO_PRECONDITION_CONFLICT');
    const restored = prepareComposition('restructure', { source_html: changed.html, revision: 3,
      scenes: changed.before_scenes, transitions: changed.before_transitions,
      expected_scenes: [{ id: 's1', durationFrames: 90 }, { id: 's2', durationFrames: 90 }],
      expected_transitions: [{ id: 's2', kind: 'fade', durationMs: 400 }] });
    expect(readSceneStructure(restored.html).scenes).toEqual(changed.before_scenes);
  });

  it('returns before values for the journal delta and marks node ops not undoable', () => {
    const result = prepareComposition('patch', {
      source_html: HTML, revision: 2,
      patches: [{ selector: '#title', property: 'text', value: 'World' }],
    });
    expect(result.before).toEqual([{ selector: '#title', property: 'text', value: 'Hello' }]);
    expect(result.undoable).toBe(true);
    const nodeOp = prepareComposition('patch', {
      source_html: HTML, revision: 2,
      patches: [{ selector: '#title', property: 'element', value: 'duplicate' }],
    });
    expect(nodeOp.undoable).toBe(false);
  });

  it('409s with structured conflicts when the current base violates the read-set', () => {
    let error: (Error & { status?: number; code?: string; conflicts?: unknown[] }) | null = null;
    try {
      prepareComposition('patch', {
        source_html: HTML, revision: 2,
        patches: [{ selector: '#title', property: 'text', value: 'Other' }],
        expected: [{ selector: '#title', property: 'text', value: 'Stale value' }],
      });
    } catch (err) { error = err as typeof error; }
    expect(error?.status).toBe(409);
    expect(error?.code).toBe('UNDO_PRECONDITION_CONFLICT');
    expect(error?.conflicts).toEqual([{ selector: '#title', property: 'text', observed: 'Hello', expected: 'Stale value' }]);
  });

  it('passes when expected values match the current base', () => {
    const result = prepareComposition('patch', {
      source_html: HTML, revision: 3,
      patches: [{ selector: '#title', property: 'text', value: 'Other' }],
      expected: [{ selector: '#title', property: 'text', value: 'Hello' }],
    });
    expect(result.prepared).toBe(true);
    expect(result.before?.[0]?.value).toBe('Hello');
  });

  it('restructure reports before scenes and 409s a mismatched scene precondition', () => {
    const result = prepareComposition('restructure', {
      source_html: HTML, revision: 2,
      scenes: [{ id: 's1', durationFrames: 60 }, { id: 's2', durationFrames: 120 }],
    });
    expect(result.before_scenes).toEqual([
      { id: 's1', durationFrames: 60 },
      { id: 's2', durationFrames: 90 },
    ]);
    expect(result.before_transitions).toEqual([{ id: 's2', kind: 'fade', durationMs: 400 }]);

    let error: (Error & { status?: number; code?: string }) | null = null;
    try {
      prepareComposition('restructure', {
        source_html: HTML, revision: 2,
        scenes: [{ id: 's1', durationFrames: 60 }, { id: 's2', durationFrames: 120 }],
        expected_scenes: [{ id: 's1', durationFrames: 60 }, { id: 's2', durationFrames: 999 }],
      });
    } catch (err) { error = err as typeof error; }
    expect(error?.status).toBe(409);
    expect(error?.code).toBe('UNDO_PRECONDITION_CONFLICT');
  });
});
