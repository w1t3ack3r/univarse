# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5
# Spec 0013 CS2: the tenant web app as Next.js standalone output, on the same Debian 13 distroless base as the
# API (docs/09 §2.1). Both bases are pinned by digest; the runtime's upstream signature is verified in CI (CS3).
ARG BUILD_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

FROM ${BUILD_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
 && pnpm turbo run build --filter=@univarse/web... \
 && chmod -R go-w apps/web/.next apps/web/public
# chmod: Next.js writes some build files 664; nothing may be writable but by root (docs/09 §2.1 rule 7).

FROM ${RUNTIME_IMAGE} AS runtime
ARG REVISION=unknown
ARG CREATED=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/w1t3ack3r/univarse" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="univarse-web"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=127.0.0.1
# The nonroot base already runs as 65532, so WORKDIR would create /app owned by the app user. Create it
# (and copy in) as root, then drop to 65532: the app can't write its own code (docs/09 §2.1 rule 7).
USER 0:0
WORKDIR /app
# Standalone server and its traced node_modules, then the static assets and public files it doesn't copy.
COPY --from=build --chown=0:0 /repo/apps/web/.next/standalone /app
COPY --from=build --chown=0:0 /repo/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build --chown=0:0 /repo/apps/web/public /app/apps/web/public
USER 65532:65532
EXPOSE 3000
CMD ["apps/web/server.js"]
