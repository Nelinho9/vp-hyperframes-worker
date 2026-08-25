// @vitest-environment node
/**
 * elements-registry.test.ts — V5-P3A (§8.1, AD-5)
 *
 * 1. deriveElements — inventário linkedom do index.html staged:
 *    candidatos/exclusões/ordem · tabela de tipos · sceneId · text/
 *    srcAssetUrl/animIn/out · bboxAtSceneStart (best-effort sem layout) ·
 *    envelope versionado · determinismo.
 * 2. persistElementsArtifact — guardas espelho de composition-persist +
 *    path/contentType/upsert.
 *
 * Doc: docs/video-engine/V5_P3A_ELEMENTS_REGISTRY.md §2
 */

import { describe, expect, it } from 'vitest';
import {
  ELEMENTS_VERSION,
  deriveElements,
  elementsStoragePath,
  persistElementsArtifact,
} from './elements-registry.js';

const FIXTURE = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div id="main" class="composition" data-composition-id="main" data-start="0" data-duration="12" data-width="1080" data-height="1920">
  <script id="__vp-anim-materialized__">void 0;</script>
  <div id="scene-1" class="clip" data-start="0" data-duration="6" data-track-index="0">
    <h1 id="text-headline-1" style="left: 340px; top: 120px; width: 400px; height: 96px; --el-x: -20px;">Olá Mundo</h1>
    <img id="img-hero" src="assets/hero.jpg" style="--el-w: 480px; --el-h: 270px;" />
    <div id="hero-bg" style="background-image: url('assets/bg.png')"></div>
    <svg id="shape-badge" viewBox="0 0 10 10"><circle id="badge-dot" r="5"></circle></svg>
    <video id="video-intro" src="assets/intro.mp4"></video>
    <audio id="audio-vo" src="assets/vo.mp3"></audio>
    <p id="text-empty">   </p>
    <span data-hf-id="stamped-label">Autostamped</span>
  </div>
  <div id="scene-2" class="clip" data-start="6" data-duration="6" data-track-index="0">
    <h2 id="text-sub-2" style="width: 300px;" data-anim-in="riseIn" data-anim-out="none">Sub</h2>
    <img id="image-outro" src="assets/outro.jpg" data-anim-in="none" />
  </div>
</div>
</body>
</html>`;

describe('deriveElements', () => {
  it('expõe a versão do envelope', () => {
    expect(ELEMENTS_VERSION).toBe(1);
  });

  it('deriva o inventário em ordem de documento com exclusões corretas', () => {
    const registry = deriveElements(FIXTURE);
    expect(registry.version).toBe(1);
    // Raiz (`main`), cenas (scene-1/scene-2) e blocos __vp* ficam FORA;
    // elementos com id OU data-hf-id entram pela ordem do documento.
    expect(registry.elements.map((e) => e.id)).toEqual([
      'text-headline-1',
      'img-hero',
      'hero-bg',
      'shape-badge',
      'badge-dot',
      'video-intro',
      'audio-vo',
      'text-empty',
      'stamped-label',
      'text-sub-2',
      'image-outro',
    ]);
  });

  it('classifica tipos por prefixo de id, tag e background-image', () => {
    const byId = new Map(deriveElements(FIXTURE).elements.map((e) => [e.id, e]));
    expect(byId.get('text-headline-1')!.type).toBe('text');
    expect(byId.get('img-hero')!.type).toBe('image');
    expect(byId.get('hero-bg')!.type).toBe('image'); // background-image url
    expect(byId.get('shape-badge')!.type).toBe('shape'); // tag svg
    expect(byId.get('badge-dot')!.type).toBe('shape'); // descendente de svg
    expect(byId.get('video-intro')!.type).toBe('video');
    expect(byId.get('audio-vo')!.type).toBe('audio');
    expect(byId.get('stamped-label')!.type).toBe('text'); // fallback do editor
  });

  it('mapeia sceneId pelo ancestral .clip mais próximo (null fora de cenas)', () => {
    const outside = deriveElements(
      `<html><body><div data-composition-id="m">
        <p id="free-text">fora</p>
        <div id="scene-9" class="clip"><b id="in-scene">dentro</b></div>
      </div></body></html>`,
    );
    const byId = new Map(outside.elements.map((e) => [e.id, e]));
    expect(byId.get('free-text')!.sceneId).toBeNull();
    expect(byId.get('in-scene')!.sceneId).toBe('scene-9');
    const fixtureById = new Map(deriveElements(FIXTURE).elements.map((e) => [e.id, e]));
    expect(fixtureById.get('text-headline-1')!.sceneId).toBe('scene-1');
    expect(fixtureById.get('image-outro')!.sceneId).toBe('scene-2');
  });

  it('transporta text trimmed (só tipo text) e omite vazio', () => {
    const byId = new Map(deriveElements(FIXTURE).elements.map((e) => [e.id, e]));
    expect(byId.get('text-headline-1')!.text).toBe('Olá Mundo');
    expect(byId.get('text-empty')).not.toHaveProperty('text');
    expect(byId.get('img-hero')).not.toHaveProperty('text');
  });

  it('transporta srcAssetUrl (src tem prioridade; bg-url com/sem aspas)', () => {
    const byId = new Map(deriveElements(FIXTURE).elements.map((e) => [e.id, e]));
    expect(byId.get('img-hero')!.srcAssetUrl).toBe('assets/hero.jpg');
    expect(byId.get('hero-bg')!.srcAssetUrl).toBe('assets/bg.png');
    const quoted = deriveElements(
      `<html><body><div data-composition-id="m">
        <div id="bg-double" style="background-image:url(&quot;a b.png&quot;)"></div>
        <div id="bg-bare" style="background-image:url(c.png)"></div>
      </div></body></html>`,
    );
    const q = new Map(quoted.elements.map((e) => [e.id, e]));
    expect(q.get('bg-double')!.srcAssetUrl).toBe('a b.png');
    expect(q.get('bg-bare')!.srcAssetUrl).toBe('c.png');
  });

  it('omite animIn/out ausentes, vazios ou none', () => {
    const byId = new Map(deriveElements(FIXTURE).elements.map((e) => [e.id, e]));
    expect(byId.get('text-sub-2')!.animIn).toBe('riseIn');
    expect(byId.get('text-sub-2')).not.toHaveProperty('animOut'); // 'none'
    expect(byId.get('image-outro')).not.toHaveProperty('animIn'); // 'none'
    expect(byId.get('text-headline-1')).not.toHaveProperty('animIn');
  });

  it('bbox best-effort: authored px + delta das vars, parcial quando incompleto', () => {
    const byId = new Map(deriveElements(FIXTURE).elements.map((e) => [e.id, e]));
    // left 340 + delta --el-x (-20) = 320; top 120 (sem var); w/h authored.
    expect(byId.get('text-headline-1')!.bboxAtSceneStart).toEqual({
      x: 320,
      y: 120,
      width: 400,
      height: 96,
    });
    // Só vars --el-w/h.
    expect(byId.get('img-hero')!.bboxAtSceneStart).toEqual({ width: 480, height: 270 });
    // Só width inline.
    expect(byId.get('text-sub-2')!.bboxAtSceneStart).toEqual({ width: 300 });
    // Nada numérico → campo omitido.
    expect(byId.get('hero-bg')).not.toHaveProperty('bboxAtSceneStart');
  });

  it('é determinístico e dedup id (primeira ocorrência ganha)', () => {
    const a = deriveElements(FIXTURE);
    const b = deriveElements(FIXTURE);
    expect(a).toEqual(b);
    const dup = deriveElements(
      `<html><body><div data-composition-id="m">
        <p id="twice">um</p><span id="twice">dois</span>
      </div></body></html>`,
    );
    expect(dup.elements).toHaveLength(1);
    expect(dup.elements[0].id).toBe('twice');
  });
});

describe('elementsStoragePath', () => {
  it('devolve o caminho canónico ao lado da composição', () => {
    expect(elementsStoragePath('p1')).toBe('projects/p1/compositions/elements.json');
  });
});

describe('persistElementsArtifact', () => {
  const UUID = 'daca85b4-0724-4d71-95b1-a72f92ee791b';
  const REGISTRY = { version: 1, elements: [{ id: 'x', type: 'text', sceneId: null }] };

  function makeClient(err: { message: string } | null, calls: Array<Record<string, unknown>>) {
    return {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: unknown, opts: unknown) => {
            calls.push({ bucket, path, body, opts });
            return err ? { error: err } : { error: null };
          },
        }),
      },
    };
  }

  it('sem cliente Supabase devolve false (worker sem creds)', async () => {
    await expect(persistElementsArtifact(null, UUID, REGISTRY)).resolves.toBe(false);
  });

  it('salta project ids não-UUID (jobs internos/testes)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(persistElementsArtifact(makeClient(null, calls), 'preview-p1', REGISTRY)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('salta registry vazio/inválido', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(persistElementsArtifact(makeClient(null, calls), UUID, null)).resolves.toBe(false);
    await expect(
      persistElementsArtifact(makeClient(null, calls), UUID, { version: 1, elements: 'nope' }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('faz upsert em video-artifacts com contentType application/json e devolve true', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(persistElementsArtifact(makeClient(null, calls), UUID, REGISTRY)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].bucket).toBe('video-artifacts');
    expect(calls[0].path).toBe(`projects/${UUID}/compositions/elements.json`);
    expect(calls[0].opts).toEqual({ contentType: 'application/json', upsert: true });
    expect(JSON.parse(String(calls[0].body))).toEqual(REGISTRY);
  });

  it('erro do storage devolve false sem lançar (fire-and-forget)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(
      persistElementsArtifact(makeClient({ message: 'Object not found' }, calls), UUID, REGISTRY),
    ).resolves.toBe(false);
  });
});
