// @vitest-environment node
/**
 * composition-publication.test.ts — F05-T06 (parte registry/persist).
 * Falha registry/persist e revisão stale impedem falso sucesso; recuperação
 * nunca sobrescreve composição mais recente.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCoherentPublication,
  toPersistResult,
  validateRevisionForWrite,
} from './composition-publication.js';

describe('validateRevisionForWrite', () => {
  it('legacy sem revisão bloqueia (nunca default silencioso)', () => {
    expect(validateRevisionForWrite({ expectedRevision: null, currentRevision: 5 }).ok).toBe(false);
    expect(validateRevisionForWrite({ expectedRevision: undefined, currentRevision: 5 }).code).toBe('LEGACY_WRITE_BLOCKED');
  });

  it('stale recusa com conflito sem sobrescrever', () => {
    const r = validateRevisionForWrite({ expectedRevision: 4, currentRevision: 5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REVISION_CONFLICT');
  });

  it('esperada igual à corrente passa', () => {
    expect(validateRevisionForWrite({ expectedRevision: 5, currentRevision: 5 }).ok).toBe(true);
  });
});

describe('buildCoherentPublication', () => {
  const REG = { version: 2, compositionId: 'main', revision: 5, elements: [{ id: 'a', revision: 5 }], conflicts: [] };

  it('exige revision explícita', () => {
    expect(() => buildCoherentPublication({ html: '<div></div>', registry: REG, revision: null })).toThrow();
  });

  it('recusa registry de revisão divergente', () => {
    expect(() => buildCoherentPublication({ html: '<div></div>', registry: REG, revision: 6 })).toThrow();
  });

  it('publica HTML/registry na mesma revisão', () => {
    const out = buildCoherentPublication({ html: '<div></div>', registry: REG, revision: 5 });
    expect(out.revision).toBe(5);
    expect(out.registry.revision).toBe(5);
    expect(out.registry.elements[0].revision).toBe(5);
  });
});

describe('toPersistResult — nunca lista vazia de sucesso', () => {
  it('completo quando ambos confirmam', () => {
    expect(toPersistResult({ htmlOk: true, registryOk: true })).toMatchObject({ persisted: true, persisted_elements: true, status: 'complete' });
  });

  it('parcial recuperável quando registry falha (sem promover set antigo)', () => {
    const r = toPersistResult({ htmlOk: true, registryOk: false });
    expect(r.persisted).toBe(true);
    expect(r.persisted_elements).toBe(false);
    expect(r.status).toBe('partial-registry-missing');
    expect(r.recoverable).toBe(true);
  });

  it('falha total nunca é sucesso', () => {
    const r = toPersistResult({ htmlOk: false, registryOk: false });
    expect(r.persisted).toBe(false);
    expect(r.status).toBe('failed');
  });
});
