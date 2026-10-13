# Image signing key (spec 0013 local release, ADR-030)

UniVarse images are signed with **the owner's local cosign key**: never a hosted service, never public Sigstore.

- `cosign.pub` (this folder, committed) is the **trusted public key**. Every verification, including the local
  deploy's, is pinned to it (LR6, LR9).
- The **private key** lives outside the repository at `%USERPROFILE%\.univarse\signing\cosign.key`, encrypted with a
  password only the owner knows. Back both up yourself. Nothing in this repository stores the password.

## Generating the key pair (owner only, offline)

From the repository root in PowerShell. It runs the pinned cosign image with **no network**, and you type the
password when cosign asks for it:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.univarse\signing" | Out-Null
docker run --rm -it --network none -v "$env:USERPROFILE\.univarse\signing:/k" -w /k ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8 generate-key-pair
Copy-Item "$env:USERPROFILE\.univarse\signing\cosign.pub" infra\signing\cosign.pub
```

Then commit `infra/signing/cosign.pub` in a PR. If the private key is ever lost or exposed, generate a new pair,
commit the new public key in a PR that says why, and re-release: images signed by the old key stop verifying.

## Releasing

`pnpm images:release` from a clean `main` builds, gates, publishes to the local registry (127.0.0.1:5000),
signs, attests and verifies, then writes a record under `releases/` (git-ignored; an index, not proof).
`pnpm images:verify releases/<record>.json` re-verifies a record against `cosign.pub`, as the local deploy does.

## Pruning the local registry (LR8)

`pnpm images:prune` lists what it would remove and changes nothing. `pnpm images:prune --apply` removes it.
It never needs the private key.

**Records only nominate.** Release records in `releases/` are editable, so the prune trusts only two things: the registry, and signed provenance that verifies against `cosign.pub`.

**It keeps,** each with everything it references (an index's children, signatures and attestations, recursively):
- the newest 20 releases, by signed start time;
- every digest in `releases/deploy-state.json` (current and rollback);
- every `--keep repo@sha256:…`;
- anything another tag points at.

**It deletes** an image only when two things hold:
- a record nominates it by the exact tag the release generated, and the registry agrees;
- cosign classifies the image as a rehearsal, an expired release of that commit, or not signed by the key at all.

A verdict of "not signed" never authorises a deletion on its own.

**Verification.** `--apply` verifies every kept release before and after deleting, using the digests from signed provenance (not from records). If any kept release can't be fully verified, it stops before deleting anything.

**Exclusion:**
- Both modes hold the registry lock, `releases/.registry.lock`. Every release holds it too, so prune and release never overlap.
- `--apply` also keeps the public registry offline for its whole run; it works through a private instance.
- If a crashed run left the lock behind, check that its process is gone, then remove the directory yourself.
- **Don't start the public registry by hand (`docker compose … up registry`) while an apply runs.** That bypasses the lock; it's a documented operational limitation.

**Volumes:** never run `docker volume prune`, because the `registry-data` volume holds the signed releases.
