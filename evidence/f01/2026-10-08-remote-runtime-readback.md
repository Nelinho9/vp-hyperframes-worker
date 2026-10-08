# F01 remote worker runtime readback (2026-10-08)

This is a read-only Coolify/API and HTTP diagnostic. It does not change the
application, worker secrets, jobs, storage, or dispatch state. Provider budget
remained 0 EUR.

## Coolify control-plane evidence

- Resource evfjtavsuuzllxneqpixofyz (vp-hyperframes-worker) returned
  status=running:healthy.
- The latest deployment is uhmqe8br50q3s6tuoj9u6bzb, status=finished, with
  commit 5e73bae3c78e52ceaf3d6f2029873f452a6d5688 on branch
  feat/video-v534-f01-contracts-security.
- The deployment configuration hash is
  fee9931daa7fe685c1cb22038116edfdc8596e54d47c4e5c1d9a665faf0b549b.
- The configured repository is Nelinho9/vp-hyperframes-worker; the F01
  Dockerfile and /docker-compose.yaml are the configured build sources.
- Coolify reports persistent storage
  evfjtavsuuzllxneqpixofyz-vp-worker-data mounted at
  /tmp/hyperframes-worker.
- Runtime env names include WORKER_SECRET, SUPERVISOR_SECRET,
  PREVIEW_SECRET, PORT, and WORKERS for the non-preview and preview
  environments. Values were never read back, printed, or written.

The Coolify API does not expose the running container image digest in the
read-only application/deployment responses. The deployment logs endpoint was
not available to this API key (403 on the application logs route; the
deployment logs path returned 404). Therefore image digest, container
identity, effective runtime environment, directory ownership/mode, and a
remote restart/durability proof remain UNKNOWN / NOT_EXECUTED.

## HTTP diagnostic

The configured public worker URL https://vp-hf.46-224-139-143.sslip.io
returned:

- GET /health -> 200, {ok:true, chrome:/usr/bin/chromium,...}.
- POST /job with no X-Worker-Secret -> 401, {error:invalid_secret}.
- GET /job/<unknown-id>/status with no secret -> 401, {error:invalid_secret}.
- GET /warmup -> 404 (Cannot GET /warmup); this endpoint is not part of
  the deployed route surface and is not treated as a failure of /health.

No authenticated admission, render, callback, provider call, signed upload,
remote job row, or remote restart was performed. Health plus the negative auth
checks do not qualify a positive worker smoke or F01 cutover. Keep F01.7 and
F01.12 open until the parent task records the digest/effective env and closes
the callback/producer channels in the approved order.

## Addendum: hosted runtime proof (2026-10-08)

The Coolify deployment log supplied for this continuation was
`deployment-a3hvmwoelyt5vd7txepoxoit-2026-10-08-15-00-42.txt`, SHA-256
`CFE6E2AE16583686C3C1BF31A3B6F8410C6B0DA5B5BEC0DFE93E1177840FFE69`. It
identifies source `Nelinho9/vp-hyperframes-worker`, branch
`feat/video-v534-f01-contracts-security`, commit
`5e73bae3c78e52ceaf3d6f2029873f452a6d5688`, build image ID
`sha256:1866608fd8b5b6369d9cdfe4384c2e2edd8d6515737fc8574c8dc317e0900ee3`,
and container `evfjtavsuuzllxneqpixofyz-20261008T144742`. The rolling update
completed and the healthcheck reported `healthy`.

Sanitised runtime logs reported 162 jobs rehydrated from
`/tmp/hyperframes-worker`, `HyperFrames worker listening on :8787`, Chromium
at `/usr/bin/chromium`, the same work directory, a connected Supabase client,
and HMAC-SHA256 preview-token enforcement. The Coolify terminal readback
reported Debian 12, hostname `fdc817a67cd3`, process `node server.js`, and
volume `evfjtavsuuzllxneqpixofyz-vp-worker-data` mounted at
`/tmp/hyperframes-worker`; the directory was `root:root` mode `755`. Only env
names were recorded: `WORKER_SECRET`, `SUPERVISOR_SECRET`, `PREVIEW_SECRET`,
`SUPABASE_URL`, `SUPABASE_KEY`, `SOURCE_COMMIT`, `COOLIFY_BRANCH`, and
`COOLIFY_RESOURCE_UUID`. Secret values were not printed or persisted. Their
SHA-256 digests were recorded as follows: WORKER_SECRET
`852ef330a0ff0ec978347e1b54ea7bbba7b0cf51cee8bdc97c2468cec6459cb3`,
SUPERVISOR_SECRET
`463f502f68217bda70a8d063b4fa5461f2c38249ffcf5f180f7c7ed7ee6729a4`, and PREVIEW_SECRET
`a07f0673176863677d2a8f906f7b1dd9ac62bf2a75f8521ab9765efe3b24fc14`.

Provider-free authenticated admission of disposable job
`f01a0000-0000-4000-8000-000000000001` returned `202 queued`; authenticated
readback returned `200 staged` with input hash
`20eed1269257a6c72efbee85e4ac194382a22120046628ecb37436fab0e9deb5`. The
same job remained `staged` with the same hash and timestamps after a controlled
`kill -TERM 1` restart and recovery. Public admission and unauthenticated
status both returned `401`. No provider, upload, callback, or paid operation
was invoked.

A second disposable job carried false callback/upload markers. Admission
returned `202`; searching the hosted runtime logs found no `F01_FAKE` match,
and both fixture directories were removed with terminal confirmation
`remaining=0`. No fixture file retained the markers.
The direct hosted-log and cleanup proof closes F01.6.

The build image ID above is not an effective running-container image digest;
the latter remains **UNKNOWN**. F01.7 therefore remains open and
`DEPLOY_BLOCKED`: positive auth, negative `401`, provider-free persistence,
volume/mode, and secret presence/distinction are evidenced, while the effective
image digest and remote missing-configuration `503` gate remain unqualified.
Provider budget remains 0 EUR.

## Commit receipt (2026-10-08)

This worker evidence is committed as `54525fd` (`docs(f01): record hosted worker runtime readback`). The corresponding app documentation commit is `57248fa`. Both remain on `feat/video-v534-f01-contracts-security`; no merge or push to `main` occurred.

Full SHA receipt correction: worker evidence `54525fdd8b7bfb41f21ca0766e9aa346c5cdbdce`; worker receipt `2768e6c459b5010ba19ca6cb74efff7891010f04`; corresponding app evidence `57248fa531d056187e7b0764072c619679d4ea65`; app receipt `ed682c0502c39b99a3a835d66347b12fc039233b`.

## Coolify build-flow clarification (2026-10-08)

The Coolify application is configured as Git source plus Dockerfile: repository `github.com/Nelinho9/vp-hyperframes-worker`, branch `feat/video-v534-f01-contracts-security`, commit `5e73bae3c78e52ceaf3d6f2029873f452a6d5688`, Dockerfile `/Dockerfile`. Container image **Image** and **Tag** are empty because no external registry image is configured. The deployment log explicitly records `Image not found (evfjtavsuuzllxneqpixofyz:5e73bae3c78e52ceaf3d6f2029873f452a6d5688). Building new image.`

Therefore source commit plus Dockerfile is the applicable immutable build identity for this resource; a registry image digest is not a configured input. The remaining F01.7 gap is terminal render/manifest persistence and no duplicate rerender after restart, which the provider-free `staged` smoke did not prove.
