# ClamAV scanning service

Standalone malware/virus scanner for the Remont India upload pipeline. Deployed as its own
Railway service — never inside the backend container. See
`backend/src/modules/uploads/upload-security.interceptor.ts` for the client side.

## Manual provisioning steps (not done by this repo's code)

These are real Railway infrastructure changes and were deliberately **not** performed as
part of building this — do them explicitly when ready to deploy:

1. Create a new Railway service in the same project/environment as the backend (`superb-wholeness` / `production`).
2. Set that service's **Root Directory** to `clamav/` — this is what makes Railway read
   `clamav/railway.json` and `clamav/Dockerfile` for this service specifically, instead of
   the repo-root `railway.json` the backend service already uses.
3. **Do not generate a public domain** for this service — it must only be reachable over
   Railway's private network. Double-check this in the service's Networking settings rather
   than assuming it's off by default.
4. Attach a Railway **Volume** mounted at `/var/lib/clamav` (at least 1GB) — this is what
   lets the signature database survive restarts instead of a full re-download every time.
5. On the **backend** service, set `CLAMAV_HOST` to this service's actual private-network
   hostname (defaults to `clamav.railway.internal` — confirm the real generated hostname in
   the dashboard once the service exists, since it's derived from the service's name).
6. Confirm the service's allocated RAM is sufficient — ClamAV's loaded signature database
   typically needs on the order of 1–1.5GB+. Under-provisioning will show up as repeated OOM
   restarts, and per the fail-closed design, every restart window means uploads are rejected
   until it recovers.

## Verify before first deploy

- `clamav/Dockerfile` assumes the official `clamav/clamav` image's own entrypoint already
  runs `freshclam` then `clamd` (per docs.clamav.net) — confirm this against the actual pinned
  image tag's behavior; if it differs, the Dockerfile needs its own entrypoint script instead
  of relying on the inherited one.
- The `HEALTHCHECK` in the Dockerfile assumes `bash` is available in the base image (used for
  its `/dev/tcp` pseudo-device to speak PING/PONG without needing netcat). Confirm this holds
  for the pinned tag.
