# F04-T01 baseline app (V5.34) — 2026-10-10

- App HEAD: `25c747dc6bcc33f2491372a739cfef1fbd0d0bf4` (branch `feat/video-v534-f04-worker-render`, derivado de `chore/video-engine-f03-personalizacao` + fecho F03 `40ec1fe`).
- CLI pinada: `0.7.109` (sem upgrade/refresh/latest implícito).
- Runtime: node v24.19.0, npm 11.6.2, deno 2.9.7.
- Baseline pré-F04: app vitest relevante 133 PASS (exportPresets/renderFresh/reconcile/patch/quality/audio/tts/builder); pós-F04 esperado +50 novos (renderEffective/dispatchOptions/renderDimensions/config01B/evidenceCorrelation).
- Inputs F03 usados: effective_config v1 + 18 fixtures 01A.
- Dependências F01/F02/F03 verificadas em `pins.json` (mesma pasta).
