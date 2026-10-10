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
