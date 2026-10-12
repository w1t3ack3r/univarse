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
