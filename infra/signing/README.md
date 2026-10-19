# Image signing key (spec 0013 local release, ADR-030)

UniVarse images are signed with **the owner's local cosign key**: never a hosted service, never public Sigstore.

- `cosign.pub` (this folder, committed) is the **trusted public key**. Every verification, including the local
  deploy's, is pinned to it (LR6, LR9).
- The **private key** lives outside the repository at `%USERPROFILE%\.univarse\signing\cosign.key`, encrypted with a
  password only the owner knows. Back both up yourself. Nothing in this repository stores the password.

## Key history

| From | Public key (sha256 of `cosign.pub`) | Why it changed |
| ---- | ----------------------------------- | -------------- |
| 2026-10-19 (second) | `48815009fd3ce65dd495bce41eea2312895960af2a2de8668e6559b5344a4e31` | **Rotated again, before it signed anything:** the previous key's password was displayed in clear while being entered (Windows PowerShell 5.1 has no `Read-Host -MaskInput`; it echoed the input), so it was treated as exposed and replaced. The exposed pair is kept aside, unused. |
| 2026-10-19 (first) | `555c9408cac366559691946ae7531bf2f8d738e00dd80313a042b42739c79b73` | **No longer trusted** (exposed, see above; it signed nothing). **Rotated:** the password of the 2026-10-12 key was lost. A key can't be opened without it, so it was replaced, offline, by the owner. The old pair is kept aside, unused, in case the password is found. |
| 2026-10-12 | `386c0f55f82e60005a03526454cd287d10eb87534d4e829c1dd7e774900de194` | The first key. Signed the release of `12083b8` (spec 0013 LR10). **No longer trusted:** releases it signed don't verify against the current `cosign.pub`. |

**Lessons recorded:**

- Store the password in a password manager **before** generating the pair, and prove it opens the key right away (`cosign public-key --key …` with the password, compared with `cosign.pub`). The release checks both before it builds anything.
- **Enter it masked.** Windows PowerShell 5.1 has no `Read-Host -MaskInput` (that's PowerShell 7) and echoes the input. In 5.1: `$env:COSIGN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Signing key password')).Password`, then `Remove-Item Env:COSIGN_PASSWORD` when done.

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
Since spec 0019 a release holds four images: `api` (also the worker), `web`, `migrate` (the stack's migration job)
and `pgbouncer`.
`pnpm images:verify releases/<record>.json` re-verifies a record against `cosign.pub`, as the local deploy does:
all four images. `--legacy` re-checks a release from before spec 0019 (api and web only) as it was signed; such a
release is never deployable.

## Pruning the local registry (LR8)

`pnpm images:prune` lists what it would remove and changes nothing. `pnpm images:prune --apply` removes it.
It never needs the private key.

**Records only nominate.** Release records in `releases/` are editable, so the prune trusts only two things: the registry, and signed provenance that verifies against `cosign.pub`.

**It keeps,** each with everything it references (an index's children, signatures and attestations, recursively):
- the newest 20 releases, by signed start time;
- every digest in `releases/deploy-state.json` (current and rollback);
- every `--keep repo@sha256:…`;
- anything another tag points at.
- every signature index whose image isn't being deleted, orphans included, with everything it lists.

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
