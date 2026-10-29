# Restore rehearsal, 2026-10-28

Written by `pnpm stack:restore-rehearsal` (spec 0020 B2-6), for the owner to commit. It holds slugs, ids, counts, hashes and times only.

| | |
| --- | --- |
| Set | `20261028T034203Z-7f7e` |
| Release | `releases/2026-10-27-c0c1cb0.json` |
| Target | the set's position 0/2C000028 |
| Tools | `e735b2b` |
| RTO | 98 s, from the first unseal to the last check |
| RPO reached | 131.3 min: the newest shipped WAL segment's age when the restore began |
| Peak memory | 111 MiB, the restore's containers together |

## The checks (D10)

| Check | Result | Detail |
| --- | --- | --- |
| files | PASS | 0 objects written through the filer, each read back over S3 with its SHA-256 equal |
| migrations and RLS | PASS | migrate --check-only: no pending migration, rls:check passes |
| audit chains at the checkpoint | PASS | every chain verifies, and holds its recorded head |
| row counts | PASS | equal to the set's, platform and 5 tenants |
| data keys unwrap | PASS | 4 of 4 |
| recovery | PASS | the ledger's destructions made to hold |
| control: decryption before recovery | PASS | 3 empty, 1 key_destroyed, 1 ok |
| decryption after recovery | PASS | 3 empty, 2 key_destroyed |
| data keys unwrap after recovery | PASS | 3 of 3 |
| audit chains after recovery | PASS | every chain verifies, with recovery's own events |
| the real ledger unchanged | PASS | its heads are as before |

## Decryption, per tenant

| Tenant | Before recovery | After recovery |
| --- | --- | --- |
| `demo-uni` | empty (0 sampled) | empty (0 sampled) |
| `paused-uni` | empty (0 sampled) | empty (0 sampled) |
| `shred-drill-20261027` | key_destroyed (3 sampled) | key_destroyed (3 sampled) |
| `shred-drill-20261028` | ok (3 sampled) | key_destroyed (3 sampled) |
| `test-poly` | empty (0 sampled) | empty (0 sampled) |
