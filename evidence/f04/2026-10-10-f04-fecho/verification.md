# F04 fecho — verification (worker) — 2026-10-10

## Gates
- `node --check` em `render-options.js`, `render-argv.js`, `render-verify.js`,
  `render-temporal.js`, `render-evidence.js`, `server.js` → PASS.

## Testes novos F04
- `render-options.test.ts` (T02: envelope guarda/reidrata; argv/MIME; invalid recusa)
- `render-output-contract.test.ts` (T07: bytes/ffprobe; PNG/GIF próprias; sem MP4-em-WebM)
- `render-evidence.test.ts` (T08: 5→2 usa set novo; zero/parcial não promove antigo)
- `render-coverage.test.ts` (T09: >5 cenas+CTA+boundaries; curtas; overlaps; nested)
- `render-persistence-f04.test.ts` (T11: repeat samehash; terminal preservado; revision recusa)
- Resultado incluído na suíte total abaixo.

## Suíte total
- `npm test` → **33 files / 422 tests PASS** (baseline F02: 386; +36 F04).
- Regressão: nenhum teste existente quebrado (compat N-1 com proveniência
  legacy-fallback explícita para jobs sem options/dims e HTML sem scene-N).

## Integração real
- Render CLI real + ffprobe + inspeção de sinal: **NOT_EXECUTED** (mesmo motivo do app).

## Quarentena
- Nenhum teste movido para quarantine nesta fase.
