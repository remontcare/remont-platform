# ClamAV scanning service

Standalone malware/virus scanner for the Remont India upload pipeline. Runs as its own
Railway service — never inside the backend container. See
`backend/src/modules/uploads/upload-security.interceptor.ts` for the client side.

## How it deploys (Git-based — no manual `railway up`)

A plain `git push` to `main` redeploys this service, the same way it redeploys the backend.

The mechanism, and why it is what it is:

- This service and the backend are built from the **same repo**, so both would otherwise
  read the repo-root `railway.json`. That file therefore deliberately does **not** pin a
  `dockerfilePath` — if it did, it would force both services to build the same Dockerfile
  (this actually happened: the clamav service built `backend/Dockerfile` and failed).
- The **backend** has its Root Directory set to `backend`, so its build context is
  `backend/` and the `DOCKERFILE` builder finds `backend/Dockerfile` by default.
- **This service** has no Root Directory (the Railway CLI cannot set one — see below), so
  its build context is the **repo root**, and it selects its Dockerfile via the service
  variable `RAILWAY_DOCKERFILE_PATH=clamav/Dockerfile`.
- Because the build context is the repo root, every `COPY` in `clamav/Dockerfile` is
  repo-root-relative (`COPY clamav/clamd.conf ...`), not a bare filename.

### Why not a Root Directory setting?

That would be the more conventional monorepo setup, but it can only be set from the Railway
dashboard: `railway environment edit --service-config <svc> source.rootDirectory` silently
returns "No changes to apply", and the Infrastructure-as-Code path (`railway config
plan/apply`) fails with an SDK/CLI version mismatch. The `RAILWAY_DOCKERFILE_PATH` approach
above achieves the same result using only CLI-settable configuration.

If you ever do set Root Directory to `clamav` in the dashboard, the build context changes to
`clamav/` and the `COPY` paths in the Dockerfile must be changed back to bare filenames.

## Service configuration (already provisioned)

- **No public domain** — reachable only over Railway's private network at
  `clamav.railway.internal:3310`. Do not add a domain.
- **Volume** mounted at `/var/lib/clamav` holds the signature database, so restarts do not
  re-download it (and do not hit ClamAV's mirror rate limits).
- Backend connects via `CLAMAV_HOST` / `CLAMAV_PORT` / `CLAMAV_SCAN_TIMEOUT_MS`.
- Sizing: ClamAV's loaded signature database needs roughly 1–1.5GB+ RAM. Under-provisioning
  shows up as OOM restarts, and because scanning fails closed, uploads are rejected while it
  is down.
