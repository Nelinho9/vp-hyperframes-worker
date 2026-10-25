// @vitest-environment node
/**
 * elements-registry-v2.test.ts — F05 (V5.34 C5/C6).
 * F05-T01 (derivação hierarchy/ordem/capabilities + conflito ids) e
 * F05-T06 (parte registry: falha/persist e revisão).
 */

import { describe, expect, it } from 'vitest';
import {
  ELEMENTS_VERSION,
  adaptV1RegistryToV2,
  deriveElements,
  isV1Registry,
  isV2Registry,
  normalizeRegistry,
} from './elements-registry.js';

const FIXTURE_V2 = `<!doctype html>
<html><body>
<div data-composition-id="main" data-duration="12" data-width="1920" data-height="1080">
  <div id="scene-1" class="clip" data-start="0" data-duration="6">
    <h1 id="scene-1-text-1" data-label="Título" style="left: 100px; top: 50px; width: 400px; z-index: 3;">Olá</h1>
    <img id="scene-1-img-1" src="assets/hero.jpg" style="z-index: 1;" />
    <div id="scene-1-group-1" data-element-type="group"><span id="scene-1-text-2">Dentro</span></div>
    <div id="bgm-main" data-element-type="audio"><audio id="scene-1-music-1" src="assets/m.mp3"></audio></div>
    <p id="dup">um</p><span id="dup">dois</span>
    <div id="hidden-1" data-hidden="true" style="display: none;">escondida</div>
    <div id="locked-1" data-locked="true">bloqueada</div>
    <div id="signed-1"><img id="signed-img" src="https://cdn.example/assets/a.jpg?Signature=abc&Expires=123" /></div>
  </div>
  <audio id="bgm-global" src="assets/bgm.mp3"></audio>
</div>
</body></html>`;

describe('F05-T01 — registry v2 hierarchy/ordem/capabilities', () => {
  it('expõe versão 2', () => {
    expect(ELEMENTS_VERSION).toBe(2);
  });

  it('deriva hierarquia real com parent/order/label/role', () => {
    const reg = deriveElements(FIXTURE_V2, { revision: 7 });
    expect(reg.version).toBe(2);
    expect(reg.compositionId).toBe('main');
    expect(reg.revision).toBe(7);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    const title = byId.get('scene-1-text-1');
    expect(title.type).toBe('text');
    expect(title.label).toBe('Título');
    expect(title.sceneId).toBe('scene-1');
    expect(title.z).toBe(3);
    expect(title.bboxSource).toBe('authored-best-effort');
    expect(title.capabilities.editableAsText).toBe(true);
    expect(title.revision).toBe(7);
    // nested group: parent real, sem coercion para text
    const inner = byId.get('scene-1-text-2');
    expect(inner.parentId).toBe('scene-1-group-1');
    expect(byId.get('scene-1-group-1').type).toBe('group');
    expect(byId.get('scene-1-group-1').capabilities.editableAsText).toBe(false);
  });

  it('áudio global tem scope composition e não é descartado', () => {
    const reg = deriveElements(FIXTURE_V2);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    expect(byId.get('bgm-global').sceneId).toBeNull();
    expect(byId.get('bgm-global').scope).toBe('composition');
    expect(byId.get('bgm-global').role).toBe('composition-audio');
  });

  it('hidden/locked com semântica explícita sem sair do registry', () => {
    const reg = deriveElements(FIXTURE_V2);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    expect(byId.get('hidden-1').hidden).toBe(true);
    expect(byId.get('locked-1').locked).toBe(true);
    expect(byId.get('locked-1').hidden).toBe(false);
    // locked não tem efeito visual próprio: sem display:none imposto aqui
  });

  it('id duplicado gera conflito identificado (nunca dedup silencioso)', () => {
    const reg = deriveElements(FIXTURE_V2);
    expect(reg.conflicts.length).toBe(1);
    expect(reg.conflicts[0].id).toBe('dup');
    // primeiro vence no inventário, segundo fica só no conflito
    expect(reg.elements.filter((e) => e.id === 'dup')).toHaveLength(1);
  });

  it('asset assinado nunca é identidade: assetRef canónico + flag', () => {
    const reg = deriveElements(FIXTURE_V2);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    const signed = byId.get('signed-img');
    expect(signed.hasSignedUrl).toBe(true);
    expect(signed.assetRef).toBe('https://cdn.example/assets/a.jpg');
    expect(signed.assetRef).not.toContain('Signature');
    expect(signed.assetProvenance).toBe('signed-url-redacted');
  });

  it('bbox sem layout é best-effort distinguida de unmeasured', () => {
    const reg = deriveElements(FIXTURE_V2);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    expect(byId.get('scene-1-text-1').bboxSource).toBe('authored-best-effort');
    expect(byId.get('hidden-1').bboxSource).toBe('unmeasured');
    expect(byId.get('hidden-1').bboxAtSceneStart).toBeUndefined();
  });

  it('preserva leitura v1 via adapter explícito', () => {
    const v1 = { version: 1, elements: [{ id: 'text-a', type: 'text', sceneId: 'scene-1', text: 'Olá' }] };
    expect(isV1Registry(v1)).toBe(true);
    const v2 = normalizeRegistry(v1, { revision: 3 });
    expect(isV2Registry(v2)).toBe(true);
    expect(v2.adaptedFrom).toBe(1);
    expect(v2.elements[0].label).toBe('text a');
    expect(v2.elements[0].bboxSource).toBe('unmeasured');
    expect(adaptV1RegistryToV2(v1).revision).toBeNull();
  });
});

describe('E04 — timing de áudio no registry (data-media-start)', () => {
  it('data-media-start vence; data-media-offset é fallback legado', () => {
    const html = `<div data-composition-id="main" data-duration="12">
      <audio id="vo1" src="a.wav" data-start="0.5" data-duration="2" data-media-start="0.25" data-media-offset="9"></audio>
      <audio id="vo2" src="b.wav" data-start="3" data-duration="2" data-media-offset="1.5"></audio>
    </div>`;
    const reg = deriveElements(html);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    expect(byId.get('vo1')).toMatchObject({ start: 0.5, duration: 2, mediaOffset: 0.25 });
    expect(byId.get('vo2')).toMatchObject({ start: 3, duration: 2, mediaOffset: 1.5 });
  });
});
