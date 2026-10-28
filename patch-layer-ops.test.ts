// @vitest-environment node
/**
 * patch-layer-ops.test.ts — F05-T03/T04 (paridade worker).
 * label/hidden/locked + move-up/down dentro do mesmo parent; cenas recusadas.
 */

import { describe, expect, it } from 'vitest';
import { applyPatchesLinkedom } from './patch-engine.js';
import { parseHTML } from 'linkedom';

const HTML = `<html><body><div data-composition-id="main">
<div id="scene-1" class="clip" data-start="0" data-duration="10">
<h1 id="text-a" data-label="A">A</h1>
<img id="img-b" src="assets/b.jpg" />
<p id="text-c">C</p>
</div></div></body></html>`;

function doc(html) {
  return parseHTML(html).document;
}

describe('F05-T03 worker — label/hidden/locked', () => {
  it('label persiste data-label sem tocar texto', () => {
    const { html, applied } = applyPatchesLinkedom(HTML, [{ selector: '#text-a', property: 'label', value: 'Novo' }]);
    expect(applied).toBe(1);
    const el = doc(html).getElementById('text-a');
    expect(el.getAttribute('data-label')).toBe('Novo');
    expect(el.textContent).toBe('A');
  });

  it('hidden esconde com display sem sair do DOM; show reverte', () => {
    const h = applyPatchesLinkedom(HTML, [{ selector: '#img-b', property: 'hidden', value: 'true' }]);
    const el = doc(h.html).getElementById('img-b');
    expect(el.getAttribute('data-hidden')).toBe('true');
    expect(el.getAttribute('style')).toMatch(/display:\s*none/);
    const s = applyPatchesLinkedom(h.html, [{ selector: '#img-b', property: 'hidden', value: 'false' }]);
    const el2 = doc(s.html).getElementById('img-b');
    expect(el2.getAttribute('data-hidden')).toBeNull();
    expect(el2.getAttribute('style') || '').not.toMatch(/display:\s*none/);
  });

  it('locked sem efeito visual', () => {
    const { html } = applyPatchesLinkedom(HTML, [{ selector: '#text-a', property: 'locked', value: 'true' }]);
    const el = doc(html).getElementById('text-a');
    expect(el.getAttribute('data-locked')).toBe('true');
    expect(el.getAttribute('style')).toBeNull();
  });
});

describe('F05-T04 worker — move dentro do parent', () => {
  it('move-up troca com irmão anterior', () => {
    const { html } = applyPatchesLinkedom(HTML, [{ selector: '#text-c', property: 'element', value: 'move-up' }]);
    const parent = doc(html).getElementById('scene-1');
    const ids = Array.from(parent.children).map((c) => c.getAttribute('id'));
    expect(ids).toEqual(['text-a', 'text-c', 'img-b']);
  });

  it('cena recusada em move/remove', () => {
    const { html, applied } = applyPatchesLinkedom(HTML, [{ selector: '#scene-1', property: 'element', value: 'remove' }]);
    expect(doc(html).getElementById('scene-1')).toBeTruthy();
    expect(applied).toBe(0);
  });
});

describe('E04 worker — element:insert (inverso de remove)', () => {
  const AUDIO = `<html><body><div id="root" data-composition-id="main">
<audio id="vo-1" src="a.wav" data-track="vo" data-start="0.5" data-duration="1" data-media-start="0.25" data-sample-rate="44100"></audio>
<audio id="vo-2" src="b.wav" data-track="vo" data-start="1.5" data-duration="1"></audio>
</div></body></html>`;

  const fragmentOf = (html: string, id: string) => {
    const el = doc(html).getElementById(id);
    if (!el) throw new Error(`missing ${id}`);
    return el.outerHTML;
  };

  it('remove → insert restaura o nó exato na posição original (ância next sibling)', () => {
    const fragment = fragmentOf(AUDIO, 'vo-1');
    const removed = applyPatchesLinkedom(AUDIO, [
      { selector: '#vo-1', property: 'element', value: 'remove' },
    ]);
    expect(removed.applied).toBe(1);
    const restored = applyPatchesLinkedom(removed.html, [
      { selector: '#vo-2', property: 'element', value: 'insert', fragment, position: 'before' },
    ]);
    expect(restored.applied).toBe(1);
    const parsed = doc(restored.html);
    const el = parsed.getElementById('vo-1');
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-start')).toBe('0.5');
    expect(el.getAttribute('data-media-start')).toBe('0.25');
    expect(el.getAttribute('data-sample-rate')).toBe('44100');
    expect(el.previousElementSibling ?? null).toBeNull();
    expect(el.nextElementSibling?.getAttribute('id')).toBe('vo-2');
  });

  it('position first insere como primeiro filho do parent', () => {
    const fragment = fragmentOf(AUDIO, 'vo-1');
    const removed = applyPatchesLinkedom(AUDIO, [{ selector: '#vo-1', property: 'element', value: 'remove' }]);
    const restored = applyPatchesLinkedom(removed.html, [
      { selector: '#root', property: 'element', value: 'insert', fragment, position: 'first' },
    ]);
    expect(restored.applied).toBe(1);
    const root = doc(restored.html).getElementById('root');
    expect(root.firstElementChild?.getAttribute('id')).toBe('vo-1');
  });

  it('id já ocupado, script, .clip e posição inválida são inócuos (applied 0)', () => {
    // Controle positivo: um fragmento com id LIVRE aplica no mesmo fixture.
    const free = applyPatchesLinkedom(AUDIO, [
      { selector: '#vo-2', property: 'element', value: 'insert', fragment: '<audio id="vo-9" src="c.wav"></audio>', position: 'after' },
    ]);
    expect(free.applied).toBe(1);

    const occupied = applyPatchesLinkedom(AUDIO, [
      { selector: '#vo-2', property: 'element', value: 'insert', fragment: fragmentOf(AUDIO, 'vo-2'), position: 'after' },
    ]);
    expect(occupied.applied).toBe(0);
    const occupiedIds = Array.from(doc(occupied.html).querySelectorAll('[id]')).map((el) => el.getAttribute('id'));
    expect(occupiedIds.filter((id) => id === 'vo-2')).toHaveLength(1);

    for (const fragment of [
      '<script id="x"></script>',
      '<div id="x" class="clip"></div>',
      '<div id="x"><span class="clip"></span></div>',
      '<div id="x" data-composition-id="other"></div>',
    ]) {
      const out = applyPatchesLinkedom(AUDIO, [
        { selector: '#vo-2', property: 'element', value: 'insert', fragment, position: 'after' },
      ]);
      expect(out.applied).toBe(0);
      expect(doc(out.html).getElementById('x')).toBeNull();
    }

    const badPosition = applyPatchesLinkedom(AUDIO, [
      { selector: '#vo-2', property: 'element', value: 'insert', fragment: fragmentOf(AUDIO, 'vo-1'), position: 'middle' },
    ]);
    expect(badPosition.applied).toBe(0);
  });
});

describe('E06 worker - catalog roots are not duplicated by the node op', () => {
  it('refuses duplicate on a data-vp-template root (nested ids would collide)', () => {
    const html = '<html><body><div id="scene-1" class="clip"><div id="gfx-lower-third-1" data-vp-template="lower-third@1"><div id="gfx-lower-third-1__title">T</div></div></div></body></html>';
    const result = applyPatchesLinkedom(html, [{ selector: '#gfx-lower-third-1', property: 'element', value: 'duplicate' }]);
    const doc2 = doc(result.html);
    expect(result.applied).toBe(0);
    expect(doc2.getElementById('gfx-lower-third-1-copy-1')).toBeNull();
  });
});
