# F06 fecho — verification (worker) — 2026-10-10

Operador: Kilo (Muse Spark). Branch: `feat/video-v534-f06-propriedades` @ `eff95834d720604f71de8753dc58da8167ef2b42` (base `b407865` = HEAD de fecho F05 em main).
Sem segredos neste recibo. Sem merge para main, sem push, sem deploy/restart.

## Implementação (F06.02/F06.06)

- `preview-helper.js`: `SELECTION_ENVELOPE_VERSION=1` + `readAuthoredAttrs`/`buildSelectEnvelope` partilhados entre click (`select`) e `element-bbox` (focus); conteúdo textual via textContent, attrs authored anim/audio, keyframes, src vivo, timing do host `[data-start]`, capabilities (`editableAsText` só text; `supportsTrim/Speed/Ducking=false`); leitura pura, sem mutation.
- Inline: Enter sozinho insere linha (multiline); Ctrl/Cmd+Enter confirma; Esc restaura via textContent e envia `edit-end` com `cancelled:true`; paste insere texto puro (`text/plain`, fallback com `createTextNode`); nunca innerHTML de conteúdo do utilizador.
- Correção no caminho: comentário com `\n` literal partia o script gerado (newline real no template) — substituído por texto sem escape; `node --check` do script gerado PASS.
- Sem diff em `/patch`, persistência, registry ou composition-publication (fiação `expected_revision`/barreira é cliente F06.08/F06.09; validação server-side futura).

## Testes

- Novo `preview-helper-f06.test.ts` (6 testes): envelope versionado, leitores partilhados, texto/anim/audio/timing/capabilities, trim/speed/ducking unsupported, Enter/Esc/cancelled, paste sem innerHTML.
- Atualizados ao contrato F06: `preview-injection.test.ts` (click via `buildSelectEnvelope`, harness keydown com ctrlKey/metaKey, Enter multiline, Esc `cancelled:true`), `helper-audio.test.ts` (`out.audio = parseAudioAttrs(el)`).
- `npm run test:all`: 37 ficheiros / 450 PASS (F05 36/444 + 1 ficheiro/6 testes F06).
- `node --check preview-helper.js`, `prop-map.js`, `composition-publication.js`, `elements-registry.js`: PASS. Script gerado (`PREVIEW_HELPER_SCRIPT`) compilado via `node --check`: PASS.
- Âmbito dirigido: `prop-map`, `preview-injection`, `helper-audio`, `preview-helper-f06`, `composition-publication`, `elements-registry-v2`, `patch-layer-ops` — todos PASS dentro do `test:all`.

## Deploy / rollback

- DEPLOY_BLOCKED: helper alterado exige merge para `main` + push `origin` + redeploy manual no Coolify ( fonte `main`, risco de SHA fixo — ver memória `coolify_worker_pinned_sha_pitfall`), tudo sem autorização nesta sessão. Nenhum deploy executado; smoke pós-deploy NOT_EXECUTED.
- Rollback: `git reset --hard b407865` + `git branch -D feat/video-v534-f06-propriedades` (nenhum HTML antigo restaurado por acidente; helper é servido, não persistido).

## Ficheiros (commit `eff95834d720604f71de8753dc58da8167ef2b42`)

- `preview-helper.js` (M)
- `preview-injection.test.ts` (M)
- `helper-audio.test.ts` (M)
- `preview-helper-f06.test.ts` (novo)
