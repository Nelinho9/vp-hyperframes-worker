# F01 disposable Linux media qualification

This harness exercises the actual worker app, queue, pinned CLI, local HTTPS upload and callback, MP4 bytes and persisted terminal state. It has no provider keys or Supabase configuration. Runtime networking is disabled; the HTTPS fixture runs on container loopback with its generated certificate explicitly trusted by Node. Authentication and path validation remain enabled.

From the worker repository:

```powershell
docker build --tag visttapro-worker:f01-local .
docker volume create visttapro-f01-media-r03
docker run --name visttapro-f01-media-r03 --init --network none --memory 1536m --cpus 2 --shm-size 256m --env F01_MEDIA_RUN_ID=v534-f01-local-media-2026-10-08-r03 --mount type=volume,source=visttapro-f01-media-r03,target=/tmp/hyperframes-worker --mount "type=bind,source=H:\Antigravity Projects\VisttaPro\vp-hyperframes-worker\evidence\f01,target=/evidence" visttapro-worker:f01-local node /evidence/qualify-media.mjs
docker run --name visttapro-f01-media-readback-r04 --init --network none --memory 1536m --cpus 2 --shm-size 256m --env F01_MEDIA_RUN_ID=v534-f01-local-media-2026-10-08-r04 --mount type=volume,source=visttapro-f01-media-r03,target=/tmp/hyperframes-worker --mount "type=bind,source=H:\Antigravity Projects\VisttaPro\vp-hyperframes-worker\evidence\f01,target=/evidence" visttapro-worker:f01-local node /evidence/qualify-media.mjs --readback
docker image inspect visttapro-worker:f01-local --format '{{.Id}}'
```

Use a fresh volume/container/run ID for another initial run. The harness refuses to overwrite an existing result. The readback run requires the same volume and a new result ID; it expects admission 200 and an unchanged media modification time. A Node process restart is also checked within each run. Generated TLS keys/certificates and private payload/state remain exclusively in the disposable Docker volume, outside Git. The fixture credentials are synthetic and distinct; even their values are redacted from saved diagnostics.

Artifacts live under `media/<run-id>/`: public status/callback binding, source hashes, FFprobe result, synthetic MP4, a frame at one second and redacted diagnostic log. PASS requires dimensions 640×360, approximately two seconds, byte-identical uploaded MP4, successful bound callback, terminal readback, duplicate 200 without another render, and Linux state mode 0600.

This qualifies a small, silent synthetic composition on the local Docker/Linux volume. It does not prove paid providers, narration/audio behavior, arbitrary media/formats, current Studio-to-remote-worker integration, remote tenant isolation or production acceptance. Any failures remain in their original run directory; record a correction in a new run rather than replacing evidence.

## Observed 2026-10-08

Corrected image `sha256:ee7fef4b0ac5a1a98be5b89976e467e5c4329923f92e18f0d95177e09aee3954`; Docker build exit 0. Run r03 and fresh-container readback r04 both exited 0 with `PASS_LOCAL_RENDER_RESTART`. Global and local package versions both 0.7.109. Authentication-negative 401, valid initial admission 202, bound callback HTTP 200, duplicate 200, persisted state mode 0600. The seven tested runtime module hashes exactly matched the final working-tree files.

MP4: H.264, 640×360, 30/1 fps, 60 frames, 2.000000 seconds, 14,240 bytes. SHA-256 `9b87d2dc1c26aeb2c5251cad2dd1e9368b482b5f24dd2e7a9e38f0c3702a168d` in both runs; local upload received identical bytes. FFmpeg extracted the one-second frame; visual inspection confirmed the blue rounded rectangle against the navy background. Process and fresh-container restart retained `done` and successful callback state; duplicate admission did not change the output modification time.

The expected `SUPABASE_CLIENT_UNAVAILABLE` / `SUPABASE_UPLOAD_FAILED` warnings for composition HTML, registry and snapshots are preserved: Supabase is deliberately absent. Only MP4 upload and callback are received by the local HTTPS fixture. This is no claim of remote Storage persistence. Containers remain stopped; the named volume retains synthetic private state for inspection, outside Git. No Docker daemon shutdown, remote deployment or provider action occurred.
