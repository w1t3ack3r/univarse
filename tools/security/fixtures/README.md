# Proof fixtures (spec 0024 G8)

Deliberately bad inputs: each gate must block on its fixture, for the finding named in CI's proof step. They are test
data, never shipped or run. Every real scan excludes this directory, and `tools/security/exceptions.mjs` reads it only
with `--root` in the proofs.
