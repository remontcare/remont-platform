# Standalone ClamAV scanning service for the Remont India upload pipeline.
#
# Deployed as its OWN Railway service, built from Git via the RAILWAY_DOCKERFILE_PATH=
# clamav/Dockerfile service variable (NOT a Root Directory setting, which the Railway CLI
# cannot set). Because of that, the Docker build context is the REPO ROOT, so every COPY
# below must be repo-root-relative (clamav/...), not bare filenames.
#
# Never part of the backend container. The backend (backend/src/modules/uploads/upload-security.interceptor.ts)
# reaches this over Railway's private network only, via clamd's TCP INSTREAM protocol
# (through the `clamscan` npm package) — no file this scans is ever written to disk on
# either side, and this service must never be given a public domain.
#
# Pinned to the real, current stable release (verified directly against Docker Hub's tag
# list at deploy time — 1.3 never existed; earlier drafts of this file guessed wrong).
# Update deliberately when a new version is verified, never by tracking `latest`.
FROM clamav/clamav:1.5.4

# The base image's own entrypoint already runs freshclam then clamd — see
# https://docs.clamav.net/manual/Installing/Docker.html. We only override config here, not
# the startup sequence. VERIFY this assumption against the image's actual ENTRYPOINT/CMD at
# first build — if the base image's startup differs from documented behavior, this Dockerfile
# needs a custom entrypoint script instead of relying on the inherited one.
COPY clamav/clamd.conf /etc/clamav/clamd.conf
COPY clamav/freshclam.conf /etc/clamav/freshclam.conf

EXPOSE 3310

# Own health/readiness signal for this service (per the "backend health endpoint stays
# independent of ClamAV" decision — this service is responsible for its own monitoring).
# Uses bash's /dev/tcp to speak clamd's PING/PONG directly, with no dependency on netcat or
# any bundled health-check script being present. --start-period gives room for the signature
# database to finish loading (and, on a first-ever deploy with an empty volume, for the
# initial freshclam download) before failures count against the container.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/3310 && printf "PING" >&3 && timeout 5 head -c 4 <&3 | grep -q PONG'
