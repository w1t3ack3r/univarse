# Proof fixtures (spec 0024 G8)

Deliberately bad inputs: each gate must block on its fixture, for the finding named in CI's proof step. They are test
data, never shipped or run. Every real scan excludes this directory, and `tools/security/exceptions.mjs` reads it only
with `--root` in the proofs.

The osv fixture is `osv/vulnerable-lockfile.yaml`, never `pnpm-lock.yaml`: GitHub's dependency graph reads every file
of that name, so its planted lodash would raise a real Dependabot alert. CI tells osv-scanner its format instead
(`--lockfile pnpm-lock.yaml:<path>`).
