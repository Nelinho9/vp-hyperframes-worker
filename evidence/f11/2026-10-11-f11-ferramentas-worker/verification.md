# Recibo de fecho F11 — ferramentas profissionais (worker)

- Data: 2026-10-11 (local, sem push/merge/deploy).
- Branch: `feat/video-v534-f11-ferramentas`; base `e6b4c30` (= HEAD de fecho F10, sem desvio).
- Diff F11: **nenhum** (`git status --short` vazio antes e depois; nenhum commit F11 neste repo).
- Testes: `npm test` 28 ficheiros / 404 PASS (igual F09/F10; sem alterações, sem flakiness nova).

## Porquê NA

A F11 não muda processamento de assets, alinhamento, export ou cache no worker
(âmbito do deploy worker na fase: "quando processamento de assets, alinhamento,
export ou cache mudar"):

- F11.1–F11.3: identidade/validação/capabilities são cliente + API Vercel.
- F11.4: presets residem no cliente (formato flui no `requested` existente).
- F11.5: sem adapter ASR em produção (probe pendente); sem mudança no worker.
- F11.6: checks editoriais determinísticos no cliente.
- F11.7: snapshots via Storage/API Vercel; outputs MP4 anteriores continuam
  sobrepostos pelo próximo finalize (limite registado, sem mudança de paths).
- F11.8: cancel/retry/resume no orquestrador Edge; sem kill de jobs no worker
  (callbacks em voo após cancel reconciliam como órfãos, sem débito duplo —
  limite registado).
- F11.9: i18n/a11y cliente.
- F11.10: recibo de finalize + guarda de cache no cliente (o worker não tem
  cache de output por `input_hash` — cada finalize corre `runRender` completo).

## Rollback

N/A (nada alterado, nada deployado). Imagem/SHA em produção intocados.

**STOP após F11; F12 NÃO iniciada.**
