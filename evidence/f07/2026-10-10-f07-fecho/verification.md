# F07 fecho — verification (worker) — 2026-10-10

Operador: Kilo (Muse Spark). Branch: `feat/video-v534-f07-timeline` (base `329652968a797e88bdc7e1937cfd149c2c0c42fe` = HEAD de fecho F06 + recibo; desvio documentado do `eff9583` citado no NEXT para não perder o recibo documental F06).
Sem segredos neste recibo. Sem merge para main, sem push, sem deploy/rollback Coolify (sem acesso/autorização).

## Implementação

- F07.02/F07.06 (espelho worker): `audio-timeline.js` novo — `deriveAudioClips` (mesma semântica do espelho app: role por tag/token, `bgm-main` → music composition-scope, sceneId opcional, source/revision/hash, volume/mute/fades clampados, `wave: pending/unavailable`, `AUDIO_DERIVATION_VERSION=1`), `secondsToFrames` explícito, `replanVoiceWindows` sem corte silencioso (`rewrite-regenerate` em overflow 5.92s/3s).
- Preservado: `elements-registry.js` intocado (já deriva start/duration/mediaOffset + scope composition para áudio sem cena + role `composition-audio`; sem filtro de cena — ED-07 conforme); `audio-presets.js` intocado (motor volume/fades com regra de overlap; reusado pela F07.06); `preview-helper.js` intocado (`supportsTrim/Speed/Ducking=false` — F07.09 conforme).
- F07.10: políticas de timing/waveform/codec documentadas no espelho app (`AUDIO_TIMELINE_INVARIANTS`); verificação por `ffprobe`/escuta NOT_EXECUTED (sem provider).

## Testes

- Novo: `audio-timeline.test.ts` (5 testes: derive voz/música/SFX + global, `bgm-main` → music, sem source → unavailable, `secondsToFrames`, overflow 5.92s/3s) — PASS.
- `npm run test:all`: 38 ficheiros / 455 PASS (F06 37/450 + 1 novo/5). `npm test` (lista fixa de 28 ficheiros) continua sem incluir os ficheiros F05/F06/F07 — desvio pré-existente do script, documentado; a gate válida é `test:all`.
- `node --check` em `audio-timeline.js`, `elements-registry.js`, `audio-presets.js`, `preview-helper.js`: PASS.
- TREF: nenhum teste movido para quarantine.

## Deploy / rollback

- DEPLOY_BLOCKED (módulo novo, sem autorização; retomar regime F05/F06: merge main → push origin → redeploy Coolify manual pelo operador). Rollback git: `git reset --hard 3296529` + `git branch -D feat/video-v534-f07-timeline`.
- CLI HyperFrames `0.7.109` preservada (sem upgrade).

## Limites

1. Render positivo real + `ffprobe`/escuta com provider: NOT_EXECUTED (sem budget/autorização).
2. Materialização ducking/trim/speed: não implementada (unsupported explícito, F07.09).
