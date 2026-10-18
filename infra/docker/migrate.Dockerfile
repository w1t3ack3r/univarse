# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5
# Spec 0019 D3: the migrate job, the fourth release role. It bootstraps roles and databases, applies both schemas'
# migrations, runs rls:check, seeds and provisions tenant data keys, once per deploy, then exits. The same bases as
# the API (Debian 13 builder and runtime, so Prisma's schema-engine binary matches the runtime's glibc), pinned by
# digest; the runtime digest's upstream signature is verified before the build (spec 0013 CS3).
# Prisma's schema engine is fetched by @prisma/engines' install script from Prisma's CDN and checked against its
# published SHA-256 (Prisma refuses a mismatch); the gates then scan the image that contains it.
ARG BUILD_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

FROM ${BUILD_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true CHECKPOINT_DISABLE=1
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
# Build the job and its workspace dependencies, deploy a pruned production tree, then put both schemas'
# migrations beside the Prisma configs the job ships (apps/migrate/prisma/*.config.mjs).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
 && pnpm turbo run build --filter=@univarse/migrate... \
 && pnpm --filter=@univarse/migrate deploy --prod --legacy /out \
 && cp -r packages/db/prisma/platform packages/db/prisma/tenant /out/prisma/ \
 && chmod -R go-w /out
# chmod: nothing may be writable but by root (docs/09 §2.1 rule 7).

FROM ${RUNTIME_IMAGE} AS runtime
ARG REVISION=unknown
ARG CREATED=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/w1t3ack3r/univarse" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="univarse-migrate"
# No update checks or telemetry from the Prisma CLI: the job talks to PostgreSQL and the key provider only.
ENV NODE_ENV=production UNIVARSE_VERSION=${VERSION} CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
USER 0:0
WORKDIR /app
# Root-owned and not writable by the app user (docs/09 §2.1 rule 7).
COPY --from=build --chown=0:0 /out /app
USER 65532:65532
# The distroless entrypoint is node. One run, then exit; the deploy waits for its status (spec 0019 LS4).
CMD ["--enable-source-maps", "dist/main.js"]
