# vp-hyperframes-worker

VisttaPro HyperFrames render worker — dumb worker service (V4-1).

## What it is

A stateful HTTP service that receives authenticated render jobs via signed URLs,
runs the HyperFrames CLI pipeline (lint → check → snapshot → render),
uploads outputs via signed PUT URLs, and calls back the orchestrator.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `WORKER_SECRET` | — | Inbound server credential, equals Edge `VIDEO_V4_WORKER_SECRET`. Missing: 503; incorrect: 401. Must differ from each private `callback.secret`. |
| `SUPERVISOR_SECRET` | — | Boot supervisor credential, equals Edge `VIDEO_V4_CRON_SECRET` after compatible Edge cutover. No fallback to inbound `WORKER_SECRET`. Explicit private `/supervise` drivers supply their own internal credential. |
| `JOB_CONCURRENCY` | `1` | Scheduler concurrency, 1–8. Keep 1 when RAM < 4 GB. `WORKERS` is a legacy CLI setting and does not control this queue. |
| `JOB_QUEUE_CAPACITY` | `16` | Active + pending admission cap, maximum 128. Full: 429 `JOB_QUEUE_FULL`. |
| `PREVIEW_SECRET` | — | HMAC secret for Studio iframe preview tokens. When set, `GET /preview/:id` requires a valid `?token=` (401 `invalid_token` otherwise); when unset, previews stay open (legacy) and a boot warning is logged. Same value as `VIDEO_V4_PREVIEW_SECRET` in the orchestrator edge secrets. |
| `WORK_DIR` | `/tmp/hyperframes-worker` | Scratch directory for job staging |
| `CHROME_PATH` | `/usr/bin/chromium` | System Chromium path |
| `HYPERFRAMES_BIN` | unset | Trusted executable path; unset invokes `npx` with argument arrays. CLI stays pinned at 0.7.109. |

Docker and per-job CLI environments force `HYPERFRAMES_NO_UPDATE_CHECK=1` and `HYPERFRAMES_NO_AUTO_INSTALL=1`. Version 0.7.109 otherwise schedules a detached global npm upgrade during ordinary commands, including build-time browser installation. This runtime must retain the approved pin.

## Deployment

Deployed via **Coolify** from this public GitHub repo:
- Build pack: Dockerfile
- Health check: `GET /health` → 200
- Runtime and CLI are provided by the pinned `hyperframes@0.7.109` npm package

## Endpoints

- `GET  /health` — health check
- `POST /job` — authenticated submission; 202 queued, 200 same immutable job, 409 changed hash, 429 capacity
- `GET  /job/:id/status` — poll job status
- `POST /job/:id/patch` — click-to-edit (linkedom DOM patch)
- `GET  /preview/:id?token=` — HMAC-signed preview (token enforced when `PREVIEW_SECRET` is set)
- `GET  /warmup` — Chromium cold-start mitigation

## F01 contracts and safe cutover (2026-10-07)

`job-contract.js` consumes the exact shared fixture `fixtures/render-job-v1.json`, also committed in the app under `supabase/functions/_shared/contracts/fixtures/`. V1 binds UUID job/project/request IDs, revision, canonical SHA-256 `input_hash`, step/mode and callback nonce/expiry. Authenticated N−1 inputs remain supported with UUID IDs and the same path/size checks. There is no unauthenticated compatibility route. Callback transport remains `X-Worker-Secret` with the distinct, private callback credential; terminal payloads echo request/revision/hash/nonce.

Admission is durable before HTTP acknowledgement. `job-state-v1.json` is a private 0600 record (payload and transport URLs included only here), written to a temporary file, fsynced, atomically renamed and, on Linux, directory-fsynced. Mount `WORK_DIR` on persistent storage with access restricted to the worker account. Run one worker process per volume: this scheduler does not establish distributed locking across replicas. `job.json` is retained for historical preview discovery, while the versioned state is authoritative for current execution and retries. Public status exposes an allowlist of identifiers, states, timings, non-secret warning fields and result references.

If a durable write fails, the scheduler stops new execution/admission (503 `DURABLE_STORE_UNAVAILABLE`) and reports `storage_available: false` in queue diagnostics. Restore storage and restart for recovery; an admitted job never executes without its durable running transition. Callback transport failures retain a generic private retry record and release the execution slot. V1 HTML belongs to hashed `inputs`; top-level HTML/assets aliases remain restricted to authenticated N−1 jobs. Preview artifact refs may explicitly be null when there is no MP4.

On boot, queued jobs resume. An interrupted running job becomes terminal `failed/WORKER_RESTART_INTERRUPTED`; it does not silently render twice. Existing staged/done/failed jobs preserve their result and callback state. A terminal callback that lacks successful delivery is retried from the saved payload on boot; retransmission of `/job` returns existing status and does not rerender. Operators can restart the worker to retry a failed callback after checking compatibility/expiry. Expired callback bindings require reconciliation through the orchestrator, never bypassing its CAS/auth checks.

Limits: JSON admission 48 MiB and 30-second body deadline; composition HTML 8 MiB; 128 flat assets/32 MiB decoded; 128 external media items; each media download 64 MiB/100,000 chunks/60 seconds including response body. CLI executes through `spawn` argument arrays, caps diagnostic buffers, and receives a separate job cache environment without mutating global environment. Jobs may only write UUID directories, flat asset filenames and approved composition asset references.

Before cutover, verify both target secrets by name/digest, compatible Edge producer, private dispatch migration and preview producer UUID support. Pause dispatch briefly if necessary; configure `WORKER_SECRET` distinct from callback auth, deploy the immutable phase candidate, then enable the V1 producer. Do not rollback to an unauthenticated `/job` or a public private-payload row. Keep the previous safe image and additive schema; if no safe predecessor is available, stop dispatch and roll forward. Health alone does not prove this cutover. This local change has no deployment receipt or live Coolify digest.

Validation: `npm test -- --reporter=dot`, plus `node --check` on changed JS modules. `job-security.test.ts` runs real local HTTP and spawned Node processes for restart/concurrency/callback recovery and a local chunked HTTP server for byte/deadline limits. The queue harness uses deterministic processing; it does not qualify Chromium/media rendering, provider networking, Linux volume durability, remote tenant isolation or production cutover. No provider calls or paid actions are required.

## E02 — correção de geometria, 19/10/2026

O deslocamento manual x/y usa margens de layout com variáveis `--el-*`, preservando `left/top` e o `transform` animado por GSAP. O consumo anterior por `translate` individual era absorvido pelo GSAP 3.14.2. `geometry-layout.js` converte apenas esse consumo legado nas cópias de preview/render, sem alterar os bytes canónicos usados para identificar a publicação.

O helper e a persistência usam a mesma origem de layout. Margens inline de 1–4 valores, precedência de longhands e `!important` são preservadas; expressões sem resolução numérica são recusadas na edição e conservadas na normalização. O helper separa a bbox visual da geometria de layout e fornece a origem da transformação para o resize de escala alinhada aos eixos. Rotação e transformações de ancestrais não foram qualificadas neste incremento.

Revisão independente local: achados fechados. Prova Playwright MCP com GSAP real: offset 51/55 constante nos seeks 0→0,5→1→0→1, movimentos repetidos 177→187 e resize com scale 0,5 mantendo a âncora visual x225, largura 100→120, incluindo margem shorthand importante. A validação natural no Studio requer o deploy deste incremento; não confundir esta fixture com essa prova.

Verificação final do incremento: `npm test`, 45 ficheiros / 577 testes PASS; `node --check` nos quatro módulos de runtime alterados PASS. Os testes de idempotência repetem a aplicação sobre o mesmo HTML e preservam os bytes.
