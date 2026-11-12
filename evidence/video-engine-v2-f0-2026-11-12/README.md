# F0 — sondas de provider e desbloqueio (plano Video-Engine v2, 2026-11-12)

Âmbito: F0.1 (migração E05), F0.2 (volume Coolify), F0.3/F0.4 (sondas pagas aprovadas no F0). Sem deploys, sem merge/push.

## F0.1 — migração E05 aplicada e verificada (resolve D6)

- `supabase db query --remote --yes -f supabase/migrations/20261028120000_video_chat_message_context.sql` executado no projeto `syyxuhrvyfxagcadrlqb` (production).
- `supabase migration repair --status applied 20261028120000 --remote --yes` → history reparada.
- Prova read-only (`information_schema.columns`): coluna `context` / `jsonb` presente em `public.video_chat_messages`.
- Efeito: os erros PGRST204 no F12 ao entrar no editor (select/insert de `context` em `videoChat.ts`) deixam de ocorrer.

## F0.2 — volume persistente JÁ EXISTE (memória anterior estava stale)

- `GET /api/v1/applications/<uuid>/storages` (Coolify via Tailscale) devolve `persistent_storages: [{ name: 'evfjtavsuuzllxneqpixofyz-vp-worker-data', mount_path: '/tmp/hyperframes-worker', created_at: 2026-08-19 }]`.
- App `vp-hyperframes-worker` (uuid `evfjtavsuuzllxneqpixofyz`): `running:healthy`.
- O endpoint de storages da API EXISTE nesta versão (POST requer campo `type`); a nota antiga "API sem endpoint de storages" foi corrigida na memória.
- Script idempotente: `scripts/coolify-volume.mjs` (check/create).

## Achado operacional (ação do operador) — ingress público do VPS

- `https://vp-hf.46-224-139-143.sslip.io/health` → **ECONNREFUSED** (443) e `http://46.224.139.143:8787/health` → timeout, a partir desta máquina.
- O Coolify responde via Tailscale (`claw-lucas-1.tailc8cca4.ts.net:8443`) e reporta o contentor healthy — o problema é o ingress público (firewall Hetzner/Traefik), não o contentor.
- Impacto potencial: dispatch das edges Supabase e previews públicos podem estar bloqueados na origem. Verificar firewall/regras de entrada e o proxy TLS do Coolify. Em 09/11 o /health público respondia 200 — algo mudou entretanto.

## F0.3 — sonda TTS (paga, aprovada no F0): PASS

- Modelo deployed `google/gemini-3-8-flash-tts`, 1 segmento PT.
- `createTask` → `success` em **10.7s**, 1 resultUrl, sem failCode. O provider recuperou da instabilidade 524 observada em 12/11 (00:42–01:45).
- task_id: `6f7964c30ad6ed6e387e3a8c3cc7c222`.

## F0.4 — sonda STT (paga, aprovada no F0): PASS — contrato do adapter deployed confirmado

- Réplica exata do `createKieAsrTranscriber`: voz real `projects/3e7992ac-…/audio/vo-1.wav` (155 564 B) → upload CDN kie.ai → `createTask` nemotron `timestamps:true` → `recordInfo` → words JSON público **sem Authorization**.
- `success` em **5.4s**, **6 palavras** com tempos não-uniformes reais (ex. "Comida" 0.24–1.027s), shape `resultObject.url`.
- task_id: `8db5d25ee5de146422f8176ad2d05fe2`.
- Conclusão D5: `result_urls: []` vinha do caminho errado (URL externo/temporário); o contrato correto (CDN upload) está implementado e deployed (video-v4-audio v83) e volta a ser provado aqui.

## Ledger de chamadas pagas (esta sessão)

| # | Provider | Operação | Custo estimado | Resultado |
|---|----------|----------|----------------|-----------|
| 1 | kie.ai | TTS 1 segmento PT (~6s áudio) | ~0,02 € | success |
| 2 | kie.ai | ASR nemotron 1 ficheiro (~3.2s áudio) | ~0,02 cr kie | success |

Saldo de créditos do utilizador: inalterado (sondas provider-side, sem débito de créditos da app).

## Evidência

- `probe-results.json` — resultados brutos das duas sondas (task ids, tempos, amostra de palavras).
- Scripts: `scripts/f0-provider-probes.mjs`, `scripts/coolify-volume.mjs`, `scripts/worker-health-probe.mjs`.