# Spec 0023: Renewing the stack's Vault tokens (the app's and the backup's)

**Status:** **Approved by the owner on 2026-10-25, T1–T9 as written.** Proposed 2026-10-23, refreshed after PR B1 and measured on the owner's stack on 2026-10-25. **Built** (implementation notes below), to be released and deployed before 2026-11-14.
**Phase:** 0. Found while planning spec 0020's PR B, and urgent. It was written to come before PR B. B1 then shipped without it, so it now comes before B2 continues past B2a (#107), and it's deployed before **2026-11-14**.
**Builds on:**

- [spec 0019](0019-local-production-stack.md): C1 (the stack's Vault, initialised 2026-10-20/21), D9 (`stack:vault`), LS6 (the smoke check);
- [spec 0006](0006-envelope-encryption.md): the app's least-privilege Transit token, and E6 (fail closed);
- [spec 0020](0020-local-backups-and-shred-ledger.md): PR B's restore (D9) and its backup token (B-9).

## Why

`configure()` (`tools/stack/src/vault.ts`) creates the app token with `token create -policy univarse-app -no-default-policy -period 768h -orphan`. Nothing renews it. A search found no `renew`, `renew-self` or `auth/token` call in `apps/api`, `packages/crypto`, `tools/stack`, the deploy or `stack:vault`. A periodic token that isn't renewed expires one period after it was last renewed, here its creation. So the API and the worker lose Transit, and with it every wrapped DEK, 32 days after the stack's Vault was initialised: **around 2026-11-21.** They fail closed (E6), so no data is exposed, but every encrypted field becomes unreadable until a new token is issued by hand.

**Since PR B1, a second token has the same gap.** B1's `configure()` also creates the **backup token** (B-9) the same way: `-policy univarse-backup -no-default-policy -period 768h -orphan`, with nothing renewing it. It was created on the owner's stack on 2026-10-24, with the move to Raft. So around **2026-11-25**, `pnpm stack:backup` loses its Vault snapshot, and the daily set fails. The app token kept its original expiry through the move, since the Raft migration copies Vault's storage, tokens and leases included. Every decision below now covers both tokens, each with its own policy and expiry. T2's self-renewal is the app's; the backup renews its own token at the start of each run, as the section on PR B describes.

Two more facts shape the fix:

- **The app token can't renew itself today.** It has no default policy (`-no-default-policy`), and `auth/token/renew-self` and `auth/token/lookup-self` come from the default policy. `tools/vault-dev.mjs` already says so: "These tokens have no default policy, so they can't look themselves up". So `vault token renew` with the app token in `VAULT_TOKEN` is refused until the policy grants it (T1).
- **`docker compose restart` doesn't reread an `env_file`.** A re-issued token reaches the API and worker only if their containers are **recreated** (T4).

## Step 0: confirm on the owner's stack (the owner runs it)

Read-only. It prints `ttl`, `expire_time` and `period`, never a token. The root token goes by environment and the app token by stdin (`token=-`, as `unseal` already does with `key=-`). That is the only way to look up a token that can't look itself up, without the token appearing as an argument. Vault's audit log records the lookup as HMACs.

In PowerShell, from the repository root, with the stack running and Vault unsealed:

```powershell
@'
import { docker } from './src/docker.js';
import { loadVaultInit, vaultCli } from './src/vault.js';
const { rootToken, appToken, backupToken } = loadVaultInit();
let failed = false;
for (const [name, token] of [['app', appToken], ['backup', backupToken]] as const) {
  if (!token) { console.log(`${name}: no token in vault-init.json`); failed = true; continue; }
  const r = vaultCli(docker, ['write', '-format=json', 'auth/token/lookup', 'token=-'], { VAULT_TOKEN: rootToken }, token);
  if (r.status !== 0) {
    console.log(`${name}: lookup failed (exit ${String(r.status)})${/bad token|invalid token/i.test(r.stderr) ? ': Vault says the token is invalid or expired' : ''}`);
    failed = true;
    continue;
  }
  const d = (JSON.parse(r.stdout) as { data: { ttl: number; expire_time: string | null; period?: number } }).data;
  console.log(`${name}: ${JSON.stringify({ ttl_days: Math.round(d.ttl / 864) / 100, expire_time: d.expire_time, period: d.period ?? null })}`);
}
process.exit(failed ? 1 : 0);
'@ | Set-Content -Encoding ascii tools\stack\token-ttl.ts
pnpm --filter @univarse/stack exec tsx token-ttl.ts
Remove-Item tools\stack\token-ttl.ts
```

**Expected:**
- **Both tokens:** `period` 2764800 (768 h). A lower `period` would mean Vault capped it at a lower max TTL, and an earlier expiry.
- **The app token:** `expire_time` about 2026-11-21.
- **The backup token:** `expire_time` about 2026-11-25.

The deadline in T8 is set by whichever expires first, a week before it.

**Measured on the owner's stack, 2026-10-25** (the release `81bba38`, Vault on Raft):

| Token | Issued | Expires | TTL then | `period` | Policies |
| --- | --- | --- | --- | --- | --- |
| App | 2026-10-20T19:42:31Z | **2026-11-21T19:42:31Z** | 27.09 days | 2764800 | `univarse-app` |
| Backup | 2026-10-24T15:54:08Z | **2026-11-25T15:54:08Z** | 30.93 days | 2764800 | `univarse-backup` |

Neither period was capped, and each token holds only its own policy, without `default`. The app token kept its original issue time and expiry through the move to Raft. So the deadline stands at 2026-11-14.

**What the first run found:** it failed for both tokens with `exit 2`, and only the rerun printed why: Vault was sealed (503, "Vault is sealed"), after a restart. A sealed Vault and an expired token are different problems with different remedies, but a bare exit code hides which one it is. That is T9.

## Decisions for approval

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| T1 | **The app and backup policies each grant their token's own renewal and lookup:** `auth/token/renew-self` (update) and `auth/token/lookup-self` (read), nothing else. | `configure()` rewrites the policy on every deploy, and a token's policies are evaluated by name, so the existing token gains them at the next deploy. **Cost:** today a leaked app token dies within 32 days on its own; with `renew-self` whoever holds it can keep it alive. Revocation (T6's `rotate`) is then the only end, as it is for a renewed token anyway. Alternative: no change to the policy. Then every renewal (T3) uses the root token, with the app token on stdin (`write auth/token/renew token=-`), and T2 isn't possible. |
| T2 | **The API and the worker renew their own token** (`packages/crypto`): at start, then every 6 hours, `renew-self` with no increment, which resets the TTL to the period. A failure is logged as a warning (an integrity signal for humans) and retried at the next tick. A refused renewal ("bad token", 403) is logged as an error that names `pnpm stack:deploy`. It never stops the process, nor changes readiness: Transit's own failures already fail closed. | It's the usual pattern for a periodic token: the token lives as long as the services do. It also covers dev (`.env`'s token). The keys job is short-lived and doesn't renew. Alternative: Vault Agent as a sidecar, which renews for the app. It's another container on the 8 GB machine, and needs an auth method (AppRole) the stack doesn't have. Alternative: no self-renewal, relying on T3 alone, so the owner must deploy or run `renew` at least every ~25 days. |
| T3 | **The deploy and `pnpm stack:vault renew` renew both tokens** (`token renew`, the token in `VAULT_TOKEN`, by environment). The deploy does it in `ensureVault`, after `configure()`. `renew` prints the TTL and expiry, never the token. | The backstop when the services were down, and the owner's manual command. With T1 refused, both use the root token and the token on stdin. |
| T4 | **An expired or revoked token is re-issued by `configure()`,** with the root token. `configure()` looks it up (root, stdin). Only Vault's definite "bad token" answer re-issues it; any other failure stops the deploy, so a Vault fault never mints tokens. The deploy then re-renders the env files and **recreates** the API and the worker (`up -d --force-recreate api worker`), since a restart keeps the old environment. The keys and migrate jobs are one-shot and read their env files fresh. | Today `if (init.appToken) return init;` keeps a dead token forever, and the only fix is editing `vault-init.json` by hand. Alternative: re-issue on every deploy (rotation), revoking the old token once the API and worker are recreated. It's stronger, but more moving parts during each deploy; it can come later as `stack:vault rotate`. |
| T5 | **`stack:smoke` fails when either token's TTL is under 7 days,** and prints the TTL and expiry. | Seven days leaves time to act after a failed renewal. With T2 the TTL is normally close to 32 days; under 7 means renewal has been failing for over three weeks. |
| T6 | **`vault-init.json` gains `appTokenAccessor`.** `configure()` saves it from `token create`, and backfills it with one lookup for an existing token. | Later lookups and a revocation then need the accessor, not the token. The accessor isn't the token, but it is kept owner-only like the rest of the file and never printed either. |
| T7 | **`tools/vault-dev.mjs` renews the dev tokens it keeps.** | It has half of the gap: it re-issues an expired token (its root lookup answers 403), but never renews a valid one. So a dev token dies 32 days after issue, mid-session, until `pnpm dev:vault` runs again. The fix is one `auth/token/renew` (root) for each token it keeps. With T2 the dev API renews its token too. CI uses a fresh dev-mode Vault per run, so CI isn't affected. |
| T8 | **One PR, next: after B2a (#107), before the rest of B2,** released and deployed before **2026-11-14**. That's a week before the app token's expiry, 2026-11-21T19:42Z, measured by Step 0. | Small and urgent. B2's restore rehearsal then builds on it (below). It changes the API and worker image (T2's renewer), so it needs a release, unlike B2a. |
| T9 | **Every token command, and `stack:smoke`, names a sealed Vault first.** `renew`, the lookups in `configure()` and T5's check read `vault status` before anything else. A sealed Vault gets its own line, "Vault is sealed: run `pnpm stack:vault unseal`", the one the deploy already prints, rather than a token failure. Each Vault error is then classified as sealed, the token invalid or expired ("bad token" or "invalid token"), or another error with Vault's own message (with anything shaped like a token redacted), never a bare exit code. | Found by Step 0's first run (above): a sealed Vault after a restart looked exactly like two dead tokens. On this laptop a reboot seals Vault, so a sealed Vault will be common. T4's re-issue must never treat it as a dead token. Alternative: leave the smoke check to fail on the API's health, which names neither cause. |

## How it meets spec 0020 PR B

- **A restored set's token can be past its period.** Restoring a Raft snapshot restores the token's lease with its old expiry. When the lease has passed, Vault's expiration manager revokes the token after unseal. T4's re-issue covers it: the restore (and `stack:restore-rehearsal`'s isolated Vault) runs `configure()`, which re-issues against the restored root token and renders the restored stack's env files. PR B's B3 tests it with a set whose token has expired, using the short test period from the tests below.
- **B-9's backup token has the same need.** B1 shipped it without renewal (see "Why"), so this spec gives it the same treatment:
  - `renew` and the deploy renew it;
  - `configure()` re-issues it when it's dead;
  - the backup renews it itself at the start of each run (its policy gets `renew-self` and `lookup-self`, as T1);
  - `stack:backup status` (B2a, #107) and the smoke check report its TTL with the app token's. If #107 merges first, this PR adds the line to its status output.
- The root token never expires, so the restore's `configure()` can always re-issue.

## Tests

- **Unit, `tools/stack/src/vault.spec.ts`, the Runner faked** (it records each call's arguments, environment names and stdin, and answers with scripted results):
  - no call carries a token value among its arguments, for every command (create, lookup, renew, re-issue). This is the mutation that matters most;
  - `renew` sends `token renew` with the app token in `VAULT_TOKEN`;
  - `configure()` with a live token keeps it; with "bad token" re-issues it and saves the new token and accessor; with any other failure throws and saves nothing;
  - each policy holds exactly its paths: the app policy its two Transit paths plus the two `-self` paths, and the backup policy its own plus the same two;
  - the backfilled accessor; the deploy recreating the API and worker when (and only when) the token changed (`deploy.spec.ts`);
  - the smoke check's threshold at 7 days, either side (`smoke.spec.ts`);
  - T9: a sealed Vault (503, "Vault is sealed") is reported as sealed by `renew`, `configure()` and the smoke check, never as a dead token, and never re-issues one. "bad token" is reported as invalid or expired, and any other error prints Vault's message with token-shaped strings redacted.
- **Unit, `packages/crypto`:** the renewer's schedule, its warning and error lines (with no token in them), and that a failure never throws into the app (fake `fetch`, fake timers).
- **Integration, CI, against the real `hashicorp/vault:2.1.1`,** `tools/stack/src/vault-token.int.ts`, in its own vitest config and CI step, like `audit-failclosed.spec.ts`: a throwaway server-mode Vault, set up by the stack's own `initialise()`:
  - the token's `period` is 768 h; after `renew`, the TTL is back to the period;
  - the app token renews and looks up itself (T1), and is still refused everything else (`sys/`, another key);
  - with a period of a few seconds (a test-only parameter of `configure()`, never exposed by the CLI), the token expires; `configure()` re-issues it, and the app's own provider wraps and unwraps with the new token;
  - Vault's exact answer for an expired token, pinned, so T4's "bad token" match can't drift with the image;
  - the provider's renewer keeps a short-period token alive past several periods.
- **Mutation-checked:** removing the renewal, the re-issue, the recreate, the threshold, or the policy's two paths each turns a test red.

## Affected docs (in the implementation PR)

- [spec 0019](0019-local-production-stack.md): D9's commands (`stack:vault renew`), LS6's new check;
- [spec 0006](0006-envelope-encryption.md): the app token's lifecycle (renewed by the services, re-issued by the deploy);
- [10 §7](../10-infrastructure-and-deployment.md) and [08](../08-security.md): the token's lifecycle and T1's trade-off;
- [spec 0020](0020-local-backups-and-shred-ledger.md): PR B's plan points here for the restore and B-9;
- `docs/HANDOFF.md`.

## Implementation notes

Built as approved, T1 to T9. It changes the API and worker image (T2's renewer), so a release follows, deployed before 2026-11-14.

**What runs where.**

- **`tools/stack/src/vault.ts`:**
  - the policies (T1): `APP_POLICY_HCL` and `BACKUP_POLICY_HCL`, each with `SELF_HCL`;
  - the classification of Vault's failures (T9);
  - `lookupToken`, with the root token by environment and the token on stdin;
  - `renewToken` and `renewTokens` (T3);
  - `configure`'s create, keep, backfill and re-issue (T4, T6);
  - `ensureVault`, which configures and then renews;
  - `tokenReport` (T5), shared by the smoke check and `stack:backup status`;
  - `renewBeforeSnapshot`, for the backup.
- **`pnpm stack:vault renew`** renews both tokens by hand. A sealed Vault is named first.
- **The deploy:**
  - it prints each token's line (`vault: app token: renewed, 32.0 days`);
  - a re-issued app token makes it recreate the API and the worker (`up -d --wait --force-recreate --no-deps api worker`). That happens after the stack is up and before the smoke check, and a failure stops the deploy.
- **`stack:smoke`:**
  - it names a sealed Vault before anything else;
  - it prints each token's remaining life;
  - it fails under 7 days.
- **`stack:backup status`** shows each token's line, with a `WARN` under 7 days. The deploy prints those warnings too.
- **The backup** renews its own token before each Vault snapshot.
- **`packages/crypto` `VaultTokenRenewer`** (T2):
  - it uses `renew-self` with no increment, at start and then every 6 hours, on a timer that never keeps a process alive;
  - Vault's answers map to outcomes: 503 is sealed (a warning), 400 or 403 is refused (an error naming `pnpm stack:deploy`), and anything else is a failure (a warning). Each outcome is logged as an event, never with the token.
- **The API and the worker:** `VaultTokenRenewal` runs it in each process, with the `vault` provider only. **`main.ts` and `worker.ts` switch it on.**
- **`tools/vault-dev.mjs`** (T7): the dev app policy gains the self paths, and a kept dev token is renewed by root.

**Decisions made while building (for approval).**

1. **Renewal is off unless the process asks.** `AppModule` and `WorkerModule` default to no renewal, and only `main.ts` and `worker.ts` pass `renewVaultToken: true`. Otherwise every integration test, and the keys CLI (which reuses `WorkerModule`), would try to renew a dev or CI token. A test pins the default.
2. **"Dead" means only Vault's own "bad token" or "invalid token",** and the integration test pins both against Vault 2.1.1:
   - the root token's lookup of a dead token says "bad token";
   - **so does a dead token renewing itself.** The plan expected it might say "permission denied" instead, but it doesn't.
   - A sealed Vault answers 503, "Vault is sealed", to every call.
3. **The backup stops only on a sealed Vault or a dead token.** Any other renewal failure lets the snapshot decide: the token still has its TTL, and losing the day's set to a transient renewal error is worse than the error itself.
4. **A renewal is logged at `info`:** 4 lines a day per process, so the logs show when the token was last kept alive.
5. **The accessors are saved and backfilled (T6), but lookups still use the token on stdin.** Stdin keeps the token off every command line already. Lookups and revocations by accessor are for a later `stack:vault rotate`.
6. **`tokenReport` lives in `vault.ts`,** shared by the smoke check (a failure) and `status` (a warning), so the two can't drift.
7. **`stack:backup status` exits 1 when the tokens can't be read**, such as with a sealed or stopped Vault, as it already does for any source it can't read.

**Evidence.**

- **Unit tests:**
  - `tools/stack`:
    - `vault.spec.ts`, against a scripted Vault: the policies, character for character; create, keep, backfill, re-issue, and stopping with nothing minted or saved; renewal; the backup's renewal; the classification and redaction. Every call is checked for a secret among its arguments;
    - `deploy.spec.ts`: the recreate and its failure;
    - `smoke.spec.ts`: the 7-day threshold on both sides;
    - `status.spec.ts`, `vault-raft.spec.ts` and `entrypoints.spec.ts`.
  - `packages/crypto`, `token-renewal.spec.ts`: each answer from Vault, the timer, and nothing ever thrown.
  - `apps/api`, `token-renewal.spec.ts`: on and off, and the modules' default.
- **Integration, `tools/stack/src/vault-token.int.ts`** (`test:vault`, a new CI step), on a throwaway Vault of the stack's pinned image, **6 of 6 passing, run here first, 76 s:**
  - both tokens periodic at 768 h, with their accessors;
  - renewal back to the full period;
  - each token renewing and looking up itself, and refused everything else;
  - a 4-second token expiring, Vault's "bad token" pinned, and `configure` re-issuing both, with the app's own `VaultTransitProvider` wrapping and unwrapping under the new token;
  - the app's renewer keeping a 5-second token alive for 13 s, then dying 7 s after it stopped;
  - a sealed Vault: "sealed" everywhere, nothing re-issued, then unsealed.
- **Mutations: 24 of 24 caught.** They cover:
  - the policies' self paths;
  - re-issuing on any failure, and never re-issuing;
  - the accessor backfill;
  - the token passed as an argument;
  - renewing with the root token;
  - the sealed check and the sealed classification;
  - a renewal failure thrown;
  - the threshold, inclusive or missing;
  - the backup stopping on any failure;
  - the recreate never happening, always happening, or failing silently;
  - `status` not warning;
  - the renewer's 403, 503, timer, first renewal and escaping failure;
  - the modules' default, and the `local` provider.
- **Not covered by a test:**
  - `stack:smoke`'s early sealed line, which needs a running stack;
  - `main.ts` and `worker.ts` switching renewal on, which are one-line flags;
  - `vault-dev.mjs`'s renewal of a kept token. CI always mints fresh tokens, so this path runs only on the owner's machine, and the owner's next `pnpm dev:vault` exercises it.

**The owner's steps after merging:**
1. **Prepare the machine:** `pnpm stack:down`, then stop the dev ClamAV, then check the dev Vault is unsealed with `pnpm dev:vault`. That run also renews the dev tokens (T7).
2. **Release:** set `COSIGN_PASSWORD`, then run `pnpm images:release`.
3. **Deploy** the new record. Its Vault lines should read `app token: renewed, 32.0 days` and `backup token: renewed, 32.0 days`.
4. **Check the smoke check's token lines:** both at about 32 days.
5. **Optionally,** look for `vault.token.renewed` in the API's and the worker's logs.
