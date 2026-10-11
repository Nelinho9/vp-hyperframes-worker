# F08 worker — verification — 2026-10-11

Operador: Kilo (Muse Spark). Branch: `feat/video-v534-f08-geometria` (base `085fc5f31d155b49714b7cb4f45eb09226b3c707` = HEAD de fecho F07, sem desvio).
Escopo: F08.01 (medicao) + F08.10 (parte worker) + paridade geom. Sem segredos neste recibo.
Sem push/merge/deploy; sem alteracao do pin HyperFrames 0.7.109; sem tocar em app files.

## Veredicto: source NA (0 alteracoes em codigo) + 1 ficheiro de testes de verificacao

- `TRANSITION_TWEENS`/duracoes INTOCADOS (F08.01 proibe): baseline medido por fixtures, sem motor paralelo.
- `preview-helper.js` INTOCADO e SEM applier de transicoes por desenho: transicoes vivem em `.clip`
  (recusados a node-ops) e mudam janelas via `/restructure` + reload do preview (`previewReloadNonce`
  no app). Hot-swap que as re-aplicasse divergiria da timeline ja bindada; o canal `/patch`
  nunca transporta `data-transition-*` (`PROP_MAP` sem entradas de transicao — testado).
- `elements-registry.js` INTOCADO e SEM `transitionIn/Out` por desenho: cenas (donas das transicoes)
  sao excluidas do inventario por contrato v2; expor transicao em elementos internos seria poluicao.
  Leitura v1 via adapter preservada. Transicoes continuam no HTML (fonte: `parseCompositionHtml` no app).
- `audio-timeline.js` INTOCADO e overlap-coerente por construcao: `deriveAudioClips` e overlap-blind
  (1 clip por elemento audio, sem double-count na zona de overlap), ROOT inalterada com overlaps,
  `replanVoiceWindows` nunca corta (overflow exige `rewrite-regenerate`).
- Paridade geom intacta: x/y/width/height/rotation -> `--el-*` + individual transforms, nunca left/top
  (worker `prop-map.js` == app `propMap.ts`, `UI_ONLY_PROPS` iguais, `GEOM_CONSUMPTION` iguais).

## Testes

- Novo: `f08-geometria-transicoes.test.ts` (19 testes) — PASS.
  - F08.01 geom: `--el-*` em landscape/portrait/square, delta x/y vs baseline authored, rotation deg,
    idempotencia byte-exata; anim authored coexistente.
  - F08.01 transicoes: 6 kinds/ordem, so opacity/transform/clipPath/filter, clamp [200,800].
  - F08.10 overlap: fade@400 estende 12f / entrante intacto / ROOT 9s / lint limpo; cenas curtas 15f
    clampeiam fade@800->fade@500; transicao na primeira cena ignorada; remocao converge byte-exato;
    round-trip `normalizeClipWindows` estavel.
  - F08.10 coerencia: `/patch` preserva blocos+attrs de transicao e animacao; `/restructure` preserva
    bloco de animacao; 4 blocos coexistem (`__vp-anim/transitions/audio/keyframes-materialized__`).
  - Registry: cenas omitidas mesmo com `data-transition-*`, zero campos de transicao, anim/audio
    preservados, `bgm-main` scope composition, adapter v1 intacto.
  - Audio x overlap: mesma derivacao com/sem transicoes (3 clips, ordem voice->music, sem duplicacao);
    replan com janela estendida 3.4s ok, overflow 5.92s/3s exige regenerate com `overflowSec` 2.92.
  - Canais: helper tem anim/keyframes/audio + paridade geom e NAO tem applier nem `data-transition-*`;
    `PROP_MAP` sem saidas `data-transition-*`.
- `npx vitest run f08-geometria-transicoes.test.ts`: 19/19 PASS.
- `npx vitest run prop-map.test.ts anim-presets.test.ts transition-materialize.test.ts patch-restructure.test.ts`: 86/86 PASS.
- `npm run test:all`: 39 ficheiros / 474 PASS (F07: 38/455 + 1 novo/19). Gate `npm test` (lista fixa)
  continua sem incluir ficheiros F05/F06/F07/F08 — desvio pre-existente, documentado; gate valida e `test:all`.
- `node --check` em `transition-presets.js`, `anim-presets.js`, `preview-helper.js`,
  `elements-registry.js`, `audio-timeline.js`, `prop-map.js`, `patch-engine.js`, `window-lint.js`: PASS.
- Fixtures de render em `fixtures/` preservadas (intocadas). TREF: nenhum teste em quarantine.

## Observacao (nao-bloqueante, fora do escopo worker-F08; candidato a F09/app+worker)

- Audio global sem `data-role` (role de registry `composition-audio`) nao deriva clip: `inferAudioRole`
  rejeita o token nos DOIS repos (paridade intacta, comportamento igual app/worker). Caminho suportado:
  `data-role="music|voice|sfx"` (fixture F08 usa `data-role="music"` em `bgm-main`). Mudar exige alteracao
  conjunta app+worker — NAO feito aqui (F08 worker nao autoriza; app files intocaveis nesta sessao).

## Deploy / rollback

- DEPLOY NA (sem diff de runtime; sem autorizacao; regime F05/F06/F07 mantido).
- Rollback git: working tree so com 1 ficheiro novo untracked; `git clean -f f08-geometria-transicoes.test.ts`
  repoe a base `085fc5f`. CLI HyperFrames `0.7.109` preservada (sem upgrade).

## Limites

1. MP4 real com provider (todas as transicoes + audio/timing) + `ffprobe`/escuta: NOT_EXECUTED (sem provider/custos autorizados).
2. Playwright MCP (drag/resize/cancel/numerico/teclado, picker em portal, preview exportado): NA no worker
   (superficie do app; sem frontend nesta sessao).
3. trim/speed/ducking: continuam unsupported explicito (F07.09 conforme; `UI_ONLY_PROPS` + capabilities).
4. Escalas 25/50/100% e pointer-coalescing/RAF: logica do app (PreviewCanvas/SelectionHandles); worker e
   agnostico a escala (coordenadas nativas) — coberto por deltas deterministicos + idempotencia.