// @vitest-environment node
/**
 * prop-map.test.ts — V5-P0B (AD-1) + V5-P1A (§6.1): tabela canónica de props
 * → geometria/CSS/atributos
 *
 * Espelho OBRIGATÓRIO de visttapro/src/video/v4/propMap.ts (repos separados
 * não partilham import): a string canónica abaixo é IDÊNTICA à do teste
 * frontend (src/video/v4/__tests__/propMap.test.ts) e qualquer deriva quebra
 * o CI num dos lados.
 *
 * Doc: docs/video-engine/V5_P0B_GEOMETRIA_TRANSFORM.md §2.2,
 *      docs/video-engine/V5_P1A_MODELO_PROPS.md §2.2
 */
import { describe, expect, it } from 'vitest';
import {
  PROP_MAP,
  PROP_MAP_CANONICAL_JSON,
  GEOM_CONSUMPTION,
  consumptionFor,
  computeGeomDelta,
  UI_ONLY_PROPS,
} from './prop-map.js';

/** String-canónica do contrato — IDÊNTICA à copia no frontend. */
const CANONICAL_JSON =
  '{"font":{"output":"font-family","kind":"decl","unit":""},"size":{"output":"font-size","kind":"decl","unit":"px"},"weight":{"output":"font-weight","kind":"decl","unit":""},"color":{"output":"color","kind":"decl","unit":""},"opacity":{"output":"opacity","kind":"decl","unit":""},"x":{"output":"--el-x","kind":"geom","unit":"px"},"y":{"output":"--el-y","kind":"geom","unit":"px"},"width":{"output":"--el-w","kind":"geom","unit":"px"},"height":{"output":"--el-h","kind":"geom","unit":"px"},"rotation":{"output":"--el-rotate","kind":"geom","unit":"deg"},"align":{"output":"text-align","kind":"decl","unit":""},"letterSpacing":{"output":"letter-spacing","kind":"decl","unit":"px"},"lineHeight":{"output":"line-height","kind":"decl","unit":""},"z":{"output":"z-index","kind":"decl","unit":""},"fit":{"output":"object-fit","kind":"decl","unit":""},"radius":{"output":"border-radius","kind":"decl","unit":"px"},"borderWidth":{"output":"border-width","kind":"decl","unit":"px"},"borderColor":{"output":"border-color","kind":"decl","unit":""},"animIn":{"output":"data-anim-in","kind":"attr","unit":""},"animOut":{"output":"data-anim-out","kind":"attr","unit":""},"animDurMs":{"output":"data-anim-dur-ms","kind":"attr","unit":""},"animDelayMs":{"output":"data-anim-delay-ms","kind":"attr","unit":""}}';

describe('PROP_MAP — contrato partilhado V5-P0B (espelho do worker)', () => {
  it('coincide byte-a-byte com o contrato cross-repo', () => {
    expect(PROP_MAP_CANONICAL_JSON).toBe(CANONICAL_JSON);
    expect(JSON.stringify(PROP_MAP)).toBe(CANONICAL_JSON);
  });

  it('nunca mapeia geometria para propriedades de layout do runtime', () => {
    for (const entry of Object.values(PROP_MAP)) {
      expect(['left', 'top', 'right', 'bottom']).not.toContain(entry.output);
    }
    for (const key of ['x', 'y', 'width', 'height', 'rotation']) {
      expect(PROP_MAP[key].kind).toBe('geom');
      expect(PROP_MAP[key].output.startsWith('--el-')).toBe(true);
      expect(PROP_MAP[key].unit).not.toBe('');
    }
  });

  it('consumo geom usa individual transforms / vars auto-contidos', () => {
    expect(GEOM_CONSUMPTION.x).toBe('translate: var(--el-x, 0px) var(--el-y, 0px)');
    expect(consumptionFor('y')).toBe(GEOM_CONSUMPTION.x);
    expect(consumptionFor('width')).toBe('width: var(--el-w)');
    expect(consumptionFor('height')).toBe('height: var(--el-h)');
    expect(consumptionFor('rotation')).toBe('rotate: var(--el-rotate, 0deg)');
    expect(consumptionFor('color')).toBeNull();
    expect(consumptionFor('desconhecida')).toBeNull();
  });

  it('computeGeomDelta converte posição absoluta desejada em delta de translate', () => {
    expect(computeGeomDelta(340, 100)).toBe(-240);
    expect(computeGeomDelta(0, 100)).toBe(100);
    expect(computeGeomDelta(120, 120)).toBe(0);
  });
});

describe('PROP_MAP — extensão V5-P1A (espelho do worker)', () => {
  it('mapeia os novos decl props para CSS com unidades corretas', () => {
    expect(PROP_MAP.align).toEqual({ output: 'text-align', kind: 'decl', unit: '' });
    expect(PROP_MAP.letterSpacing).toEqual({ output: 'letter-spacing', kind: 'decl', unit: 'px' });
    expect(PROP_MAP.lineHeight).toEqual({ output: 'line-height', kind: 'decl', unit: '' });
    expect(PROP_MAP.z).toEqual({ output: 'z-index', kind: 'decl', unit: '' });
    expect(PROP_MAP.fit).toEqual({ output: 'object-fit', kind: 'decl', unit: '' });
    expect(PROP_MAP.radius).toEqual({ output: 'border-radius', kind: 'decl', unit: 'px' });
    expect(PROP_MAP.borderWidth).toEqual({ output: 'border-width', kind: 'decl', unit: 'px' });
    expect(PROP_MAP.borderColor).toEqual({ output: 'border-color', kind: 'decl', unit: '' });
  });

  it('transporta animação como atributos data-anim-* (nunca estilo)', () => {
    for (const [key, output] of [
      ['animIn', 'data-anim-in'],
      ['animOut', 'data-anim-out'],
      ['animDurMs', 'data-anim-dur-ms'],
      ['animDelayMs', 'data-anim-delay-ms'],
    ] as const) {
      expect(PROP_MAP[key]).toEqual({ output, kind: 'attr', unit: '' });
      expect(consumptionFor(key)).toBeNull();
    }
  });

  it('UI_ONLY_PROPS lista as flags sem efeito render (aceitação P1 #4)', () => {
    for (const prop of [
      'autoAspect', 'volume', 'muted', 'fadeIn', 'fadeOut',
      'ducking', 'trimStart', 'trimEnd', 'speed',
    ]) {
      expect(UI_ONLY_PROPS.has(prop)).toBe(true);
      expect(PROP_MAP[prop]).toBeUndefined();
    }
    expect(UI_ONLY_PROPS.has('opacity')).toBe(false);
  });
});
