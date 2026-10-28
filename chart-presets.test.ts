// @vitest-environment node
/**
 * chart-presets (E06) — static, seek-safe chart materialization.
 *
 * The app authors ONE `data-vp-chart` JSON attribute; this block renders its
 * children at boot with `textContent` only. Tests execute the ES5 source on a
 * linkedom document and assert structure, deterministic heights, unit
 * round-trip, escaping and block upsert/removal.
 */
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  CHART_APPLY_SOURCE,
  CHART_BARS,
  CHART_CANONICAL_JSON,
  CHART_MAX_BAR_PX,
  upsertChartBlock,
  touchesChartProps,
} from './chart-presets.js';

const SPEC = {
  title: 'Crescimento',
  series: '2026',
  unit: '%',
  source: 'Fonte: dados internos',
  labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun'],
  values: [12, 18, 24, 31, 38, 46],
  accent: '#c8ff3d',
  textColor: '#ffffff',
  background: 'rgba(12,12,16,0.88)',
};

function render(spec = SPEC) {
  const html = `<html><body><div id="gfx-bar-chart-1" data-vp-chart='${JSON.stringify(spec)}' style="display:flex"></div></body></html>`;
  const { document } = parseHTML(html);
  new Function('document', `${CHART_APPLY_SOURCE}\n__vpApplyCharts();`)(document);
  return { document, host: document.getElementById('gfx-bar-chart-1') };
}

describe('chart-materialized (E06)', () => {
  it('publishes a canonical contract identical to the frontend', () => {
    expect(CHART_CANONICAL_JSON).toBe(JSON.stringify({ bars: CHART_BARS, maxBarPx: CHART_MAX_BAR_PX, version: 1 }));
  });

  it('materializes exactly six columns with deterministic heights and texts', () => {
    const { host } = render();
    expect(host.querySelectorAll('.gfx-chart-col')).toHaveLength(CHART_BARS);
    const bars = Array.from(host.querySelectorAll('.gfx-chart-bar'));
    const heights = bars.map((bar) => {
      const match = /height:(\d+)px/.exec(bar.getAttribute('style') ?? '');
      return match ? Number(match[1]) : null;
    });
    expect(heights[0]).toBe(Math.max(6, Math.round((12 / 46) * CHART_MAX_BAR_PX)));
    expect(heights[5]).toBe(CHART_MAX_BAR_PX);
    expect(host.querySelector('.gfx-chart-title')?.textContent).toBe('Crescimento');
    expect(host.querySelector('.gfx-chart-unit')?.textContent).toBe('(%)');
    expect(host.querySelectorAll('.gfx-chart-value')[0]?.textContent).toBe('12%');
    expect(host.querySelectorAll('.gfx-chart-label')[0]?.textContent).toBe('Jan');
  });

  it('renders authored labels as text, never as markup', () => {
    const { host } = render({ ...SPEC, labels: ['<img src=x onerror=alert(1)>', 'B', 'C', 'D', 'E', 'F'] });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('.gfx-chart-label')[0]?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('keeps units with digits lossless (values are raw JSON numbers)', () => {
    const { host } = render({ ...SPEC, unit: 'M2' });
    expect(host.querySelectorAll('.gfx-chart-value')[0]?.textContent).toBe('12M2');
  });

  it('omits the unit parenthesis when the unit is empty', () => {
    const { host } = render({ ...SPEC, unit: '' });
    expect(host.querySelector('.gfx-chart-unit')).toBeNull();
  });

  it('is idempotent for the same attribute value', () => {
    const { document, host } = render();
    const firstCount = host.children.length;
    new Function('document', `${CHART_APPLY_SOURCE}\n__vpApplyCharts();`)(document);
    expect(host.children.length).toBe(firstCount);
  });

  it('upserts/removes exactly one static block and is byte-idempotent', () => {
    const withChart = '<html><body><div id="gfx-bar-chart-1" data-vp-chart="{}"></div></body></html>';
    const once = upsertChartBlock(withChart);
    expect(once).toContain('id="__vp-chart-materialized__"');
    const twice = upsertChartBlock(once);
    expect((twice.match(/__vp-chart-materialized__/g) ?? [])).toHaveLength(1);
    expect(twice).toBe(once);
    const without = upsertChartBlock('<html><body><div id="x"></div></body></html>');
    expect(without).not.toContain('__vp-chart-materialized__');
  });

  it('rejects CSS injection in authored colors (fallback, no url())', () => {
    const { host } = render({
      ...SPEC,
      accent: 'red;background:url(https://evil.example/x)',
      background: 'transparent;background-image:url(https://evil.example/y)',
      textColor: '#fff;position:fixed',
    } as typeof SPEC);
    const bar = host.querySelector('.gfx-chart-bar');
    expect(bar?.getAttribute('style')).toContain('#c8ff3d');
    expect(host.getAttribute('style') ?? '').not.toContain('evil.example');
  });

  it('detects chart prop patches', () => {
    expect(touchesChartProps([{ property: 'chart' }])).toBe(true);
    expect(touchesChartProps([{ property: 'text' }])).toBe(false);
  });
});
