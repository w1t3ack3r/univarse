# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5
# Spec 0017 D1 (revision 4): PgBouncer built from checksum-verified upstream source, on distroless. Debian slim
# plus PGDG's package failed the zero-HIGH/CRITICAL gate (52 unfixed findings, spec 0017's implementation finding).
# Built without c-ares, PAM, LDAP or systemd: DNS goes through libevent (`adns: evdns2`). The runtime base supplies
# glibc, OpenSSL, zlib and zstd with its own package records; only the binary and libevent (with libevent's own
# Debian package record, so scanners see it) are copied in. PB10's inventory and tie check verify all of it.
ARG BUILD_IMAGE=debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ARG RUNTIME_IMAGE=gcr.io/distroless/base-debian13:nonroot@sha256:a0d70d6a97cd697d9362bc2aae4a6560dd65817e365d0043b07325a97975dc91
# Upstream publishes a SHA-256 per release and no signature; this pin is the reviewed tarball.
ARG PGBOUNCER_VERSION=1.26.1
ARG PGBOUNCER_SHA256=00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9

FROM ${BUILD_IMAGE} AS build
ARG PGBOUNCER_VERSION
ARG PGBOUNCER_SHA256
# The slim base tells dpkg to skip docs; libevent's record lists its changelogs and copyright, and the copied files
# must match the record exactly (PB10), so packages here install complete.
RUN rm /etc/dpkg/dpkg.cfg.d/docker \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config libevent-dev libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo pgbouncer.tgz "https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz" \
 && echo "${PGBOUNCER_SHA256}  pgbouncer.tgz" | sha256sum -c - \
 && tar -xzf pgbouncer.tgz --strip-components=1 \
 && ./configure --prefix=/usr --without-cares --without-pam --without-ldap --without-systemd \
 && make -j"$(nproc)" pgbouncer \
 && strip pgbouncer
# The runtime tree: the binary, and libevent's package exactly as dpkg installed it (every file its md5sums lists,
# plus the soname link), with its record in distroless's per-package layout (status.d/<pkg>, <pkg>.md5sums).
RUN set -eu; pkg=libevent-2.1-7t64; \
    install -D -m 0755 pgbouncer /out/usr/bin/pgbouncer; \
    mkdir -p /out/var/lib/dpkg/status.d; \
    dpkg-query -s "$pkg" | grep -v '^Status:' > "/out/var/lib/dpkg/status.d/$pkg"; \
    cp "/var/lib/dpkg/info/$pkg:amd64.md5sums" "/out/var/lib/dpkg/status.d/$pkg.md5sums"; \
    cut -c35- "/out/var/lib/dpkg/status.d/$pkg.md5sums" | while read -r f; do install -D -m 0644 "/$f" "/out/$f"; done; \
    for l in $(dpkg -L "$pkg" | grep '\.so\.'); do if [ -L "$l" ]; then cp -P "$l" "/out$l"; fi; done; \
    chmod 0644 /out/var/lib/dpkg/status.d/*; \
    chmod -R go-w /out

FROM ${RUNTIME_IMAGE} AS runtime
ARG PGBOUNCER_VERSION
ARG PGBOUNCER_SHA256
ARG REVISION=unknown
ARG CREATED=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/w1t3ack3r/univarse" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="univarse-pgbouncer" \
      org.univarse.pgbouncer.version="${PGBOUNCER_VERSION}" \
      org.univarse.pgbouncer.source-sha256="${PGBOUNCER_SHA256}"
# Root-owned and not writable by the runtime user (docs/09 §2.1 rule 7).
USER 0:0
COPY --from=build --chown=0:0 /out/ /
USER 65532:65532
EXPOSE 6432
ENTRYPOINT ["/usr/bin/pgbouncer"]
CMD ["/etc/pgbouncer/pgbouncer.ini"]
