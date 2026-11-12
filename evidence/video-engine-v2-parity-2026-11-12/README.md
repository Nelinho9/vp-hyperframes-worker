# Video-Engine v2 — Provas de Paridade F1/F2 (emenda F) — 2026-11-12

**Veredito: `PARITY_PROVEN`** — ≥3 vídeos completos gerados integralmente no worker
(`V4_BUILD_ON_WORKER=true` + `V4_LLM_STEPS_ON_WORKER=design,storyboard,audio,visual,quality`),
cada um confirmado **independentemente via REST oficial** (não pelo auto-relato do script).

Conta de prova: `teste1@visttapro.com` (`a4918a0a-d6e4-46b0-b9dd-3cbfbe3bb1e0`), créditos de teste.
Projeto Supabase: `syyxuhrvyfxagcadrlqb`. Worker: `https://vp-hf.46-224-139-143.sslip.io` (Coolify).

## Provas PASS (3 vídeos, 2宽高比 + repetição 9:16)

| project_id | Nome | Ratio | credits | quality score | audio | MP4 |
|---|---|---|---|---|---|---|
| `24909d75-d3e1-4ea2-8ac0-dbf4fd1b269d` | Tasca do Largo | 9:16 | 10 | 7 | 5/5 acoustic + bgm | ✅ |
| `ea6ec054-a9c7-4226-bc43-908fa0b69ae8` | Tasca do Largo | 9:16 | 10 | 7 | 5/5 acoustic + bgm | ✅ |
| `cf33434f-23c9-4597-9988-59a786191f3b` | FlowDesk | 16:9 | 10 | 7 | 4/5 acoustic + bgm | ✅ |

Cada PASS: manifesto **8/8 steps done** (capture/design/storyboard/audio/visual/build/finalize/quality),
`video_v4_jobs` todos `done` **sem refund**, `credits.spent=10` com `by_step` correto (sem contagem dupla),
artefactos Storage presentes: `renders/output.mp4`, `renders/build.mp4`, `compositions/build-input.html`,
`audio_meta.json`, `quality_report.json` (VLM `deepseek-v4-1-flash`, `needs_attention=false`).

`cf33434f` audio 4/5 vo: voice_fit parcial **honesto** (E01-B) — um segmento omitido por overflow de
janela, documentado em `voice_fit_failures`; o pipeline prossegue e o quality gate pontua normalmente.

Artefactos por projeto: `{project_id}-{build-input.html,audio_meta.json,quality_report.json}`.
Ledger cumulativo: `parity-ledger.json` (`cumulative_passed=3`, `verdict=PARITY_PROVEN`).

## Root causes encontrados e corrigidos (debug sistemático, evidência → fix)

As primeiras rondas falharam; cada falha foi root-caused com evidência real (logs worker, REST,
job-state, pg_constraint) antes de corrigir:

1. **`MUSIC_CONFIG_MISSING` (audio)** — o adapter de storage do worker não tinha
   `writeTextIfAbsent`/`writeBinaryIfAbsent` (o gate de música exige claim atómica C2/R03).
   Fix: espelhar os métodos da edge `video-v4-audio`. (worker `833028f`)
2. **Manifesto escrito pelo worker + contagem dupla de créditos** — o `runStep` vendado escrevia
   o manifesto diretamente da BD enquanto o job corria; o watchdog encadeava o step seguinte e
   zumbificava o job vivo. Fix: `db.updateManifest` do worker é NO-OP (orchestrator é o único
   writer; settle CAS no callback). (worker `833028f`)
3. **`workerJobAlive` não reconhecia jobs llm-step** — o loop de zombies do `/resume` fechava jobs
   llm-step vivos com `WORKER_JOB_LOST` + refund. Fix: incluir design/storyboard/audio/visual/quality
   no `workerJobAlive` (teto F7 25min). (visttapro `14567e02`)
4. **`BUILD_CREDENTIALS_HTTP_401`** — `acceptsServiceCredential` não aceitava o `x-worker-secret`
   do worker no fetch JIT. Fix: aceitar `workerSecret`. (visttapro `14567e02`)
5. **`F04_DIMS_MISSING`** — o harness semeava `effective_config` sem dims. Fix: semear
   `effective_width/height/ratio` (espelho do `videoConfigResolution`). (script)
6. **`BUILD_LLM_HTTP_524`** — o origin kie.ai devolve 524 intermitente sob carga para o prompt
   pesado do build (~12–14k tokens). Fix: retry budget do build alargado para **8 tentativas**,
   backoff `[5,15,30,60,120,120,120]s` (emenda E: worker é o único dono do retry, sem wall-cap de
   edge); 4xx permanentes falham já. (worker `e10dbc8` → `662a253`)
7. **Quality gate nunca pontuava** — três camadas:
   - `video_v4_jobs.step` CHECK constraint **não incluía `quality`** → INSERT do job quality violava
     o constraint (`JOB_RESERVATION_FAILED`), gate ficava pending. Fix: migração aditiva
     `20261112210000_fix_v4_jobs_quality_step.sql` (aplicada + verificada via `pg_get_constraintdef`).
   - `runQualityAfterFinalize` chamava sempre a edge, ignorando a flag. Fix: honrar
     `V4_LLM_STEPS_ON_WORKER=quality` → dispatch llm-step no worker. (visttapro `881b1db0`)
   - `discoverEvidenceManifestPaths` não encontrava manifests: o `list` adapter removia o último
     segmento do prefixo de diretório e produzia paths `//`; e build+finalize publicavam 2 manifests
     na mesma revisão → `EVIDENCE_AMBIGUOUS`. Fix: `list` strip só de barras finais (edge+worker) +
     **apenas finalize publica evidence** na Storage. (visttapro `7cc63d4b`, worker `875711c`)

## Gates

- Worker: **698/698** (55 ficheiros) — inclui regressões de retry budget, claims de storage,
  NO-OP do manifesto, discovery de evidence.
- App+edges+studio (isolado): **603/603 ficheiros, 7094/7094 testes**.
- Quality edge suite: **112/112** (3 regressões de discovery novas).
- Orchestrator queue+llmStepWorker: **149/149**.

## Flags & deploy (autorizado pelo operador)

- `V4_BUILD_ON_WORKER=true`, `V4_LLM_STEPS_ON_WORKER=design,storyboard,audio,visual,quality` (ON).
- Worker `662a253` deployed via Coolify (health 200). Edges orchestrator/quality deployed.
- Migração quality step aplicada no remoto.
- Uptime Kuma **2.5.11** no VPS (tailnet `:8445`), 2 monitores Up (Worker Health + App).

## Rollback

Flags off → caminho edge intacto (paridade testada). Reverts isolados por commit. A migração do
constraint é aditiva (alarga o CHECK, não remove dados). O evidence finalize-only não afeta o
build render (manifest local mantido para observabilidade).