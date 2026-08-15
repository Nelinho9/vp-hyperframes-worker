# vp-hyperframes-worker

VisttaPro HyperFrames render worker — dumb worker service (V4-1).

## What it is

A stateless HTTP service that receives render jobs via signed URLs,
runs the HyperFrames CLI pipeline (lint → check → snapshot → render),
uploads outputs via signed PUT URLs, and calls back the orchestrator.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `CALLBACK_SECRET` | — | Shared secret for orchestrator callback auth |
| `WORKERS` | `1` | Max concurrent renders (keep 1 when RAM < 4 GB) |
| `PREVIEW_SECRET` | — | HMAC secret for Studio iframe preview tokens |
| `WORK_DIR` | `/tmp/hyperframes-worker` | Scratch directory for job staging |
| `CHROME_PATH` | `/usr/bin/chromium` | System Chromium path |
| `HYPERFRAMES_BIN` | `hyperframes` | HyperFrames CLI binary |

## Deployment

Deployed via **Coolify** from this public GitHub repo:
- Build pack: Dockerfile
- Health check: `GET /health` → 200
- Skills are cloned from the public HyperFrames repo at Docker build time

## Endpoints

- `GET  /health` — health check
- `POST /job` — submit a render job
- `GET  /job/:id/status` — poll job status
- `POST /job/:id/patch` — click-to-edit (linkedom DOM patch)
- `GET  /preview/:id?token=` — HMAC-signed preview
- `GET  /warmup` — Chromium cold-start mitigation
