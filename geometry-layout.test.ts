import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { normalizeManualGeometry, readAuthoredMargin } from './geometry-layout.js';
import { applyPatchesLinkedom, readPatchTargetValues } from './patch-engine.js';
import { deriveElements } from './elements-registry.js';

describe('manual layout stays independent of animated transform', () => {
  const html = '<html><body><div data-composition-id="main"><div id="title" style="position:absolute;left:96px;top:700px;margin-left:20px;margin-top:10px;width:200px;height:100px;--el-x:51px;--el-y:55px;translate:var(--el-x, 0px) var(--el-y, 0px);transform:rotate(2deg)">Hello</div></div></body></html>';
  it('migrates only the old editor consumer and is idempotent', () => {
    const normalized = normalizeManualGeometry(html);
    const el = parseHTML(normalized).document.querySelector('#title')!;
    expect(el.style.getPropertyValue('translate')).toBe('');
    expect(el.style.getPropertyValue('--el-margin-x')).toBe('20px');
    expect(el.style.getPropertyValue('--el-margin-y')).toBe('10px');
    expect(el.style.getPropertyValue('transform')).toBe('rotate(2deg)');
    expect(normalizeManualGeometry(normalized)).toBe(normalized);
    expect(normalizeManualGeometry(html.replace('var(--el-x, 0px) var(--el-y, 0px)', '15px 20px'))).toBe(html.replace('var(--el-x, 0px) var(--el-y, 0px)', '15px 20px'));
  });
  it('read-set and registry use the same authored margin and manual offset', () => {
    const patched = applyPatchesLinkedom(html, [{ selector: '#title', property: 'x', value: '177' }]).html;
    expect(readPatchTargetValues(patched, [{ selector: '#title', property: 'x' }])).toEqual([{ selector: '#title', property: 'x', value: '177' }]);
    const entry = deriveElements(patched).elements.find(e => e.id === 'title');
    expect(entry?.bboxAtSceneStart?.x).toBe(177);
    expect(applyPatchesLinkedom(patched, [{ selector: '#title', property: 'x', value: '177' }]).html).toBe(patched);
  });
  it.each([
    ['margin:10px', 10, 10], ['margin:10px 20px', 20, 10],
    ['margin:10px 20px 30px', 20, 10], ['margin:10px 20px 30px 40px', 40, 10],
    ['margin:10px 20px;margin-left:25px', 25, 10],
    ['margin-left:25px;margin:10px 20px', 20, 10],
    ['margin-left:25px!important;margin:10px 20px', 25, 10],
    ['margin:10px 20px!important', 20, 10],
  ])('preserves inline margin cascade: %s', (style, x, y) => {
    expect(readAuthoredMargin(String(style), 'left').pixels).toBe(x);
    expect(readAuthoredMargin(String(style), 'top').pixels).toBe(y);
    const source = html.replace('margin-left:20px;margin-top:10px', String(style));
    const el = parseHTML(normalizeManualGeometry(source)).document.querySelector('#title')!;
    expect(parseFloat(el.style.getPropertyValue('--el-margin-x'))).toBe(x);
    expect(parseFloat(el.style.getPropertyValue('--el-margin-y'))).toBe(y);
    const serialized = el.getAttribute('style')!;
    if (String(style).includes('margin:')) expect(serialized.lastIndexOf('margin-left:')).toBeGreaterThan(serialized.indexOf('margin:'));
    if (String(style).includes('!important')) expect(serialized).toMatch(/margin-left:calc\([^;]+!important/);
  });
  it('unsupported expressions are not treated as zero', () => {
    const source = html.replace('margin-left:20px', 'margin-left:2em');
    expect(normalizeManualGeometry(source)).toBe(source);
    expect(() => applyPatchesLinkedom(source, [{ selector: '#title', property: 'x', value: '177' }])).toThrow('GEOMETRY_MARGIN_UNRESOLVED');
  });
});
