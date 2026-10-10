# F05 fecho — verification (worker) — 2026-10-10

Operador: Kilo (Muse Spark). Branch: `feat/video-v534-f05-camadas` @ `40cabe1` (base F04 em main).
Sem segredos neste recibo. Sem merge para main, sem push, sem deploy real (Coolify segue main; deploy exigiria promoção com autorização).

## Implementação

- `elements-registry.js` v1→v2: mesmos campos v1 + compositionId/parentId/order/orderInParent/label/role/hidden/locked/z/scope/bboxSource/assetRef/assetProvenance/hasSignedUrl/typeProvenance/capabilities/start/duration/mediaOffset/revision + `conflicts` (duplicados identificados, primeiro vence, nunca dedup silencioso). `data-element-type` explícito e tokens group/shape sem coercion para text. Áudio global (`sceneId` null + audio) com scope `composition`. `assetRef` canónico sem query (assinadas nunca identidade; `srcAssetUrl` v1 mantido por compat + flag). bbox best-effort distinguida (`authored-best-effort` vs `unmeasured`). `adaptV1RegistryToV2`/`normalizeRegistry`/`isV1Registry`/`isV2Registry`.
- `composition-publication.js` novo: `validateRevisionForWrite` (legacy sem revisão → `LEGACY_WRITE_BLOCKED`; stale → `REVISION_CONFLICT` 409), `buildCoherentPublication` (HTML/registry mesma revisão), `toPersistResult` (parcial recuperável, nunca lista vazia de sucesso).
- `patch-engine.js`: node ops `move-up/down/top/bottom` no mesmo parent + props `label` (`data-label`), `hidden` (`data-hidden` + `display:none`, reversível), `locked` (`data-locked`, sem efeito visual). Cenas root-owned continuam recusadas.
- `preview-helper.js`: paridade runtime (hot-swap) para `move-*`/`label`/`hidden`/`locked`.
- Testes atualizados: `elements-registry.test.ts` (versão 2 + conflito), `patch-restructure.test.ts` (versão 2).

## Testes

- Novos: `elements-registry-v2.test.ts` (F05-T01: hierarchy/ordem/capabilities, áudio global, hidden/locked, conflito, asset assinado, bbox source, adapter v1), `composition-publication.test.ts` (F05-T06: legacy/stale/coerência/parcial), `patch-layer-ops.test.ts` (F05-T03/T04 worker: label/hidden/locked/move + guarda cena).
- Comando: `npm run test:all -- --reporter=dot patch-layer-ops.test.ts elements-registry-v2.test.ts composition-publication.test.ts` → 3 ficheiros / 22 testes PASS.
- Afetados: `preview-injection.test.ts patch-restructure.test.ts patch-layer-ops.test.ts elements-registry.test.ts elements-registry-v2.test.ts composition-publication.test.ts` → 6 ficheiros / 141 testes PASS.
- Suite completa: `npm run test:all -- --reporter=dot` → **36 ficheiros / 444 testes PASS** (F04: 33/422; +3 ficheiros/+22 testes F05).
- Gates: `node --check` em `elements-registry.js`, `patch-engine.js`, `composition-publication.js` PASS. Dockerfile inalterado; CLI 0.7.109 preservada (sem upgrade).
- Deploy: DEPLOY_BLOCKED (sem acesso Coolify/API na sessão; preparação completa no branch; rollback = main `40cabe1`). Smoke/MP4 real: NOT_EXECUTED (sem provider/budget; prova DOM + unitária na evidência app).

## Ficheiros (stage task-owned)

- `elements-registry.js` (M), `patch-engine.js` (M), `preview-helper.js` (M)
- `elements-registry.test.ts` (M), `patch-restructure.test.ts` (M)
- `composition-publication.js` (novo), `composition-publication.test.ts` (novo)
- `elements-registry-v2.test.ts` (novo), `patch-layer-ops.test.ts` (novo)
- este recibo.
