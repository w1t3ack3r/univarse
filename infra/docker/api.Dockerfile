# syntax=docker/dockerfile:1.10
# Spec 0013 CS1: one image for the API and the worker (docs/09 §2.1). Builder and runtime are both Debian 13
# (trixie), so anything shipping platform binaries matches the runtime's glibc. Password hashing uses Node's
# built-in crypto.argon2() (ADR-016): nothing native is compiled for it. Both bases are pinned by digest; the
# runtime digest's upstream signature is verified in CI before this build (CS3).
ARG BUILD_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

FROM ${BUILD_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
# Build the API and its workspace dependencies, then deploy a pruned production tree: each workspace
# package ships only its `files` (dist, plus openapi.json for the client).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
 && pnpm turbo run build --filter=@univarse/api... \
 && pnpm --filter=@univarse/api deploy --prod --legacy /out \n && chmod -R go-w /out  # nothing may be writable but by root (docs/09 §2.1 rule 7)

FROM ${RUNTIME_IMAGE} AS runtime
ARG REVISION=unknown
ARG CREATED=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/w1t3ack3r/univarse" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="univarse-api"
ENV NODE_ENV=production UNIVARSE_VERSION=${VERSION}
# The nonroot base already runs as 65532, so WORKDIR would create /app owned by the app user. Create it
# (and copy in) as root, then drop to 65532: the app can't write its own code (docs/09 §2.1 rule 7).
USER 0:0
WORKDIR /app
# Root-owned and not writable by the app user (docs/09 §2.1 rule 7).
COPY --from=build --chown=0:0 /out /app
USER 65532:65532
EXPOSE 8080
# The distroless entrypoint is node. Tracing loads first (spec 0012 OB9). Worker: the same image with
# CMD ["--enable-source-maps", "--import", "./dist/otel.js", "dist/worker.js"].
CMD ["--enable-source-maps", "--import", "./dist/otel.js", "dist/main.js"]
