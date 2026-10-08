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
