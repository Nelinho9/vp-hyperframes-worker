# F01 worker local verification — 2026-10-07

Baseline: branch `feat/video-v534-f01-contracts-security`, HEAD `87df7ba54108e6bd07fbdf1d26c4a84e2fd14351` before phase implementation. No remote write, deployment, provider action or commit was performed by this worker task. HyperFrames remains `0.7.109` in package/lock/Dockerfile.

## Implemented paths

- `server.js` authenticates `/job` before body parsing using `WORKER_SECRET`/`X-Worker-Secret`, independent of each callback credential. Missing configuration yields 503; bad authentication yields 401. Admission body limits/deadlines precede side effects.
- `job-contract.js` validates V1 and authenticated N−1 UUID/schema/bounds/path inputs. V1 recomputes canonical immutable `input_hash`. A callback credential equal to inbound auth is rejected. Status is an allowlist, including approved upload booleans/storage refs and generic error codes; private payloads, local output paths, credentials and signed transport URLs are omitted.
- `job-queue.js` admits an immutable payload to a private atomically written/fsynced versioned state before 202 acknowledgement. Existing same job/hash returns 200, changed hash 409, full queue 429. Concurrency/capacity default to 1/16. Queued jobs resume after restart; running jobs become terminal `WORKER_RESTART_INTERRUPTED`; staged/done/failed state and callback results survive. Terminal callback retry uses saved state and does not start a new render.
- `job-environment.js` supplies job-specific extraction cache to each CLI invocation without changing global environment. Lint now uses `spawn` argument arrays. Diagnostic buffers are bounded; URL-bearing CLI diagnostics are redacted. Signed upload and callback errors do not echo response bodies into status/logs.
- `bounded-fetch.js` and `media-preloader.js` enforce byte/chunk/count limits and a deadline spanning headers plus streamed body. Downloads never choose an unbounded `arrayBuffer` path. Staging shares the bounded scheduler with rendering.
- README and Compose document/configure auth, queue, volume, compatibility, cutover and safe rollback. No render capabilities or snapshot provenance were added; those remain F04 scope.

## Commands and observed results

| Command | Result |
|---|---|
| `npm test -- --reporter=dot` | **PASS**, 28 files / 400 tests, final full run 22.95 seconds |
| `npx vitest run job-security.test.ts --reporter=dot` | **PASS**, 14 tests, 8.68 seconds after final constant-time/UUID/config normalization review |
| `npx vitest run pipeline-runner.test.ts supervise-route.test.ts job-security.test.ts --reporter=dot` | **PASS**, 39 tests, 3.90 seconds after distinct boot-supervisor credential correction |
| `node --check server.js` | **PASS** |
| `node --check media-preloader.js` | **PASS** |
| `node --check job-contract.js` | **PASS** |
| `node --check job-queue.js` | **PASS** |
| `node --check bounded-fetch.js` | **PASS** |
| `node --check job-environment.js` | **PASS** |
| `node --check pipeline-runner.js` | **PASS** |
| `git diff --check` | **PASS**, only Git LF→CRLF notices |

The producer/consumer fixture bytes are identical at `fixtures/render-job-v1.json` and app `supabase/functions/_shared/contracts/fixtures/render-job-v1.json`. File SHA-256: `4132f862e4fed672fb65c49e1e742333b0ced918dbea38d9682a6234f0954a6d`. Worker parser independently recomputes and verifies the fixture's logical input digest.

New tests use real local HTTP and actual spawned Node process termination/restart: active=1/pending=1, third admission=429, duplicate=200, changed payload=409; queued completion and terminal preservation after restart; callback 503 then 200 on next boot without additional execution; simultaneous real subprocesses see distinct per-job cache paths; chunked overflow and body stalled after headers fail within byte/deadline bounds. HTTP tests exercise the real worker `/job` authentication and UUID rejection, while the restart/render execution harness uses deterministic local processing.

During verification, a previous full rerun recorded **FAIL** for two new integration tests that exceeded Vitest's default five-second timeout under simultaneous host workloads (397 PASS / 2 FAIL). A scoped 30-second integration timeout was added; the subsequent full run passed 400 tests. No production timeout was increased. Existing preview tests were updated to authenticated UUID jobs and await durable asynchronous staging; their original negative assertions remain exercised.

## Acceptance boundaries

**VALIDADO_LOCAL** for the listed contracts/scheduler/network bounds. **DEPLOY_BLOCKED / NOT_EXECUTED** for live Coolify target/digest, coordinated Edge/database cutover, credential rotation, live tenant/RLS isolation and safe remote rollback. Neither the deterministic harness nor the suite proves Chromium render/media parity, provider networking or Linux persistent-volume durability. Windows tests prove process restart recovery on this local filesystem; Linux directory-fsync and owner-only file modes require deployment qualification. One process per volume is required; distributed replica locking is not implemented. Browser/frontend acceptance is performed by the parent F01 task, not by this worker subtask.

Legacy `job.json` preview discovery is retained for compatibility; new `job-state-v1.json` is authoritative for current execution. Historical markers do not become proof of a current durable render. Retry of an expired callback binding requires orchestrator reconciliation; auth/CAS/expiry must not be bypassed. Providers/paid actions remained at 0 EUR.

## Boot supervisor credential correction

Review found that historical `pipeline-runner.normalizeDriver` derived internal orchestrator authentication from `WORKER_SECRET`. That credential now authenticates inbound dispatch and must remain distinct. Boot fallback now requires `SUPERVISOR_SECRET`, configured as the Edge cron credential after the compatible F01 Edge cutover; it never falls back to inbound dispatch auth. Explicit authenticated `/supervise` drivers retain their separate private internal credential. Tests verify the chosen secret, no fallback with dispatch-only environment, and actual route boot registration. Edge counterpart must accept the cron credential on the driver's `X-Worker-Secret` header; parent F01 implementation coordinates that acceptance. No remote configuration or rotation was performed here. Compose and README list the new boot environment requirement by name only.

## Continuation — 2026-10-08

Reviewed the actual Edge producer again with the Edge task. Its preview dispatch deliberately sends `artifact_paths.mp4 = null`; the worker now accepts that approved absence. The shared finalize fixture alone did not cover this variant. V1 rejects top-level `index_html`/`assets` overrides because those legacy aliases were outside `input_hash`; current Edge producer bytes are under hashed `inputs`. Authenticated N−1 legacy aliases remain available. Public nested timings now accept finite numbers only; upload/output references must be project-scoped storage paths, excluding absolute local paths.

Fault injection now covers a durable running-write failure (no processing begins, new admission 503, execution slot released) and a thrown callback transport (generic retry state persisted, second queued job still executes). Storage failure halts pumping until an operator restores storage and restarts. These assertions cover the real queue module; earlier HTTP/process restart evidence remains preserved above.

| Command | Current result |
|---|---|
| `npm test -- --reporter=dot --silent` | **PASS**, 28 files / 404 tests, 25.73 seconds |
| `npm run test:all -- --reporter=dot --silent` | **PASS**, discovery covers the same 28 files / 404 tests, 23.50 seconds |
| `node --check` for `server.js`, `media-preloader.js`, `job-contract.js`, `job-queue.js`, `bounded-fetch.js`, `job-environment.js`, `pipeline-runner.js` | **PASS**, seven files |
| `git diff --check` | **PASS**, LF→CRLF notices only |
| Both fixture `Get-FileHash -Algorithm SHA256` | **PASS**, same `4132f862e4fed672fb65c49e1e742333b0ced918dbea38d9682a6234f0954a6d` |

### Cutover environment and compatibility matrix

| Worker surface | Worker credential name | Matching Edge name | Compatibility |
|---|---|---|---|
| Inbound `/job`, status, `/supervise` | `WORKER_SECRET` | `VIDEO_V4_WORKER_SECRET` | Missing 503, incorrect 401; distinct from callback |
| Job callback to Edge | private `callback.secret` carried per job | `VIDEO_V4_CALLBACK_SECRET` | V1 nonce/job/project/step/revision/hash/expiry and Edge CAS must all match; rotate only after public channels close |
| Boot supervisor `/status` + `/step` + `/resume` | `SUPERVISOR_SECRET` | Effective cron credential, preferably `VIDEO_V4_CRON_SECRET` | Edge task confirms acceptance via `x-worker-secret`; no inbound-secret fallback |
| Explicit `/supervise` internal driver | private `driver.secret` | Current Edge internal callback/cron credential | Inbound auth remains separate; compatibility verified locally with mock transport |
| Studio preview token | `PREVIEW_SECRET` | `VIDEO_V4_PREVIEW_SECRET` | Preserve current configured value; no rotation by hypothesis |

Baseline source `87df7ba54108e6bd07fbdf1d26c4a84e2fd14351` did not protect `/job` and cannot serve as a safe rollback candidate. Keep the additive redaction/auth boundary; with no known safe predecessor, halt dispatch and roll forward. Parent owns immutable branch commit/deploy receipt, real credential digests, Linux volume/directory-fsync and remote positive/negative smoke. No worker subtask commit, push, deploy, rotation or paid provider action occurred.

## Docker pin qualification — 2026-10-08

The first full Docker build returned exit 0, but the initial qualification `v534-f01-local-media-2026-10-08-r01` recorded **FAIL** before authentication/render. Global CLI package metadata/binary were absent; local `/app/node_modules/hyperframes` still reported 0.7.109. Read-only inspection found the old global package moved into `.hyperframes-*` and a pending CLI auto-install targeting 0.8.141. The pinned CLI's actual `autoUpdate.ts` implementation schedules detached npm installation during ordinary commands unless `HYPERFRAMES_NO_UPDATE_CHECK` or `HYPERFRAMES_NO_AUTO_INSTALL` is set. The build-time `hyperframes browser ensure` had invoked that behavior. First image ID: `sha256:fec568c779e30a24b948940c64c3220d309846ca543889e48d2971739895ec54`.

The Dockerfile now sets both suppression flags before browser ensure and carries them into runtime; every job CLI environment also forces both flags. No upgrade was performed. This prevents mutation of the explicit approved 0.7.109 pin. `npm test -- --reporter=dot --silent` after that change: **PASS**, 28 files / 404 tests, 17.38 seconds. `node --check job-environment.js`, `node --check evidence/f01/qualify-media.mjs` and `git diff --check`: **PASS**. The original FAIL receipt remains at `media/v534-f01-local-media-2026-10-08-r01/result.json`; corrected image/media qualification uses fresh run IDs and a fresh volume.

### Corrected actual renderer qualification

Docker rebuild exit 0; final local image `sha256:ee7fef4b0ac5a1a98be5b89976e467e5c4329923f92e18f0d95177e09aee3954`. [Harness/runbook](qualify-media.md) records exact commands. [Run r03](media/v534-f01-local-media-2026-10-08-r03/result.json) and [fresh-container readback r04](media/v534-f01-local-media-2026-10-08-r04/result.json) both **PASS**, exit 0, with external network disabled and synthetic auth/local trusted HTTPS only. Actual default `npx` worker CLI and global CLI packages both report 0.7.109. Runtime source hashes for seven changed modules matched final working-tree bytes.

Observed `/job` 401 without auth, initial valid admission 202, done callback HTTP 200 with exact job/project/request/step/revision/input hash/nonce, upload-byte equality, duplicate admission 200, terminal/callback preservation after Node process restart and fresh-container restart on the same Docker volume, and unchanged MP4 modification time. Linux durable state file mode **0600**; the Linux directory-fsync path executed on that local volume. This adds real renderer/Linux-volume evidence to earlier deterministic harness results; it does not simulate a power-loss test.

Final synthetic media: **H.264, 640×360, 30 fps, 60 frames, 2.000000 s, 14,240 bytes**. [MP4](media/v534-f01-local-media-2026-10-08-r03/output.mp4) SHA-256 `9b87d2dc1c26aeb2c5251cad2dd1e9368b482b5f24dd2e7a9e38f0c3702a168d`, identical after fresh-container readback. [Extracted frame at 1 s](media/v534-f01-local-media-2026-10-08-r03/frame.png) inspected: expected blue rounded rectangle visible on navy, no blank output.

Supabase absence/upload warnings for HTML, registry and snapshots are deliberately retained in redacted logs. MP4 upload and callback use the local fixture; remote Storage, audio/narration, other formats, provider behavior, Studio-to-remote-worker, production version/rotation and remote RLS remain **NOT_EXECUTED/DEPLOY_BLOCKED** in this worker task. Credentials/certificates/private payloads stay solely in the disposable named volume, outside Git. No remote deploy/push/commit or paid action occurred; containers are stopped and Docker Desktop remains running.
