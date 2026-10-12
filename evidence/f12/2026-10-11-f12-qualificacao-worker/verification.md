# Recibo F12 — qualificação integrada e entrega (worker) — PARCIAL EM EXECUÇÃO

- Data: 2026-10-11 (local, sem push/merge/deploy).
- Branch: `feat/video-v534-f12-qualificacao`; base `29897a4`
  (= `e6b4c30` HEAD de fecho F10 + recibo NA F11 docs-only; desvio registado, zero código).
- Diff F12: **nenhum** (`git status --short` vazio; render F12 corre no worker de
  produção via Coolify, sem alterar este repo).
- Testes: `npm test` **28 ficheiros / 404 PASS** (igual F09/F10/F11; re-verificado
  no estado F12, sem flakiness nova).

## Porquê NA (runtime)

A F12 até aqui não muda processamento de assets, alinhamento, export ou cache no
worker. O fix restore (High#1) é rota API Vercel + Storage; o recibo de finalize
e a guarda de cache continuam no cliente. O render real F12.05 corre contra o
worker deployado (imagem/SHA de produção intocados por esta fase).

## Rollback

N/A (nada alterado, nada deployado). Imagem/SHA em produção intocados.

**STOP parcial; F12 NÃO fechada.**

## F12-voz � 2026-10-12 (append-only)

Fix `d5aa20b` (`main`): `jobMediaOutcomes` declarado em `stageJob` mas consumido em `runRender` (ReferenceError em qualquer render que chegasse a evidence; mascarado por falhas no gate). Ponte via job record (`media_prestage_outcomes`). node --check 0; suite 480/480 PASS. Push `main 4fe8539..d5aa20b`; Coolify redeploy manual do operador, verificado por comportamento (renders seguintes publicam evidence). Rollback = revert do commit + redeploy.
