# syntax=docker/dockerfile:1
#
# Frontera Enterprise Host — the pilot runtime image (PROD-03-03).
#
# Built from the repository (a clean clone or `git archive` export), never from
# a developer's node_modules, .env or databases: .dockerignore admits only the
# sources the build needs. See docs/deployment/PILOT_DEPLOYMENT.md.
#
#   docker build --build-arg FRONTERA_BUILD_COMMIT="$(git rev-parse HEAD)" -t frontera-host:pilot .
#
# FRONTERA_BUILD_COMMIT is the only build input. It is recorded in
# dist/release-identity.json and served by GET /version; without it the image
# is a `development` build and says so.
#
# The image holds no secret and no state. Configuration and secrets arrive as
# environment variables at run time; all durable state lives under
# /var/lib/frontera, which must be a mounted volume.

# Node 22 LTS, pinned by version and digest. The major must satisfy
# package.json "engines" (tests/pilot-deployment-kit.structure.test.mjs).
ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

# ---- build: install from the lockfile, compile, record the release identity ----
FROM ${NODE_IMAGE} AS build
# better-sqlite3 normally installs a prebuilt binary; this toolchain is its
# documented fallback when no prebuild matches (build stage only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build
ARG FRONTERA_BUILD_COMMIT=
RUN FRONTERA_BUILD_COMMIT="${FRONTERA_BUILD_COMMIT}" node scripts/release/write-release-identity.mjs
# The runtime dependency tree, reinstalled from the same lockfile: the root
# package and the packages/* workspaces it loads, production dependencies only
# (no compiler, no apps, no dev tooling).
RUN rm -rf node_modules \
 && npm ci --omit=dev --include-workspace-root --no-audit --no-fund \
      $(for package in packages/*; do printf -- '--workspace=%s ' "$package"; done)
# Stage exactly what runs: compiled output (tests, source maps and build caches
# removed), the workspace packages' compiled output, the runtime dependency
# tree, the operator scripts and the legal notices.
RUN set -eu; \
    mkdir -p /out/packages; \
    cp -a package.json package-lock.json LICENSE NOTICE.md COPYRIGHT.md TRADEMARKS.md node_modules scripts dist /out/; \
    for package in packages/*; do \
      mkdir -p "/out/$package"; \
      cp -a "$package/package.json" "/out/$package/"; \
      if [ -d "$package/dist" ]; then cp -a "$package/dist" "/out/$package/"; fi; \
    done; \
    find /out/dist /out/packages -type d \( -name __tests__ -o -name dist-test \) -prune -exec rm -rf {} +; \
    find /out/dist /out/packages -type f \( -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.map' -o -name '*.tsbuildinfo' \) -delete

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ARG FRONTERA_BUILD_COMMIT=
LABEL org.opencontainers.image.title="Frontera Enterprise Host" \
      org.opencontainers.image.revision="${FRONTERA_BUILD_COMMIT}" \
      org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"
ENV NODE_ENV=production
WORKDIR /app
# Code is owned by root and read-only to the service user.
COPY --from=build /out/ /app/
# The only writable locations: the Host's state root and, for the bundled
# reference witness, its own separate state root (a different volume).
RUN mkdir -p /var/lib/frontera /var/lib/frontera-witness /etc/frontera \
 && chown node:node /var/lib/frontera /var/lib/frontera-witness \
 && chmod 0700 /var/lib/frontera /var/lib/frontera-witness
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
# Readiness, not liveness: /ready answers 200 while the Host is degraded but
# serving; it is 503 only when a required module or store is failing.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "scripts/deploy/probe.mjs", "http", "/ready"]
CMD ["node", "scripts/run-enterprise-host.mjs"]
