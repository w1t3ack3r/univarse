# Restore rehearsal, 2026-11-22

Written by `pnpm stack:restore-rehearsal` (spec 0020 B2-6), for the owner to commit. It holds slugs, ids, counts, hashes and times only.

| | |
| --- | --- |
| Set | `20261122T112108Z-1ccb` |
| Release | `releases/2026-11-22-135236a.json` |
| Target | the set's position 1/D1002490 |
| Tools | `135236a` |
| RTO | 2.4 min, from the first unseal to the last check |
| RPO reached | 2.4 min: the newest shipped WAL segment's age when the restore began |
| Peak memory | 129 MiB, the restore's containers together |

## The checks (D10)

| Check | Result | Detail |
| --- | --- | --- |
| files | PASS | 0 objects written through the filer, each read back over S3 with its SHA-256 equal |
| migrations and RLS | PASS | migrate --check-only: no pending migration, rls:check passes |
| audit chains at the checkpoint | PASS | every chain verifies, and holds its recorded head |
| row counts | PASS | equal to the set's, platform and 8 tenants |
| data keys unwrap | PASS | 8 of 8 |
| recovery | PASS | the ledger's destructions made to hold |
| control: decryption before recovery | PASS | 3 empty, 2 ok, 3 key_destroyed |
| decryption after recovery | PASS | 3 empty, 1 ok, 4 key_destroyed |
| data keys unwrap after recovery | PASS | 7 of 7 |
| audit chains after recovery | PASS | every chain verifies, with recovery's own events |
| the real ledger unchanged | PASS | its heads are as before |

## Decryption, per tenant

| Tenant | Before recovery | After recovery |
| --- | --- | --- |
| `demo-uni` | empty (0 sampled) | empty (0 sampled) |
| `elizadeuni` | ok (1 sampled) | ok (1 sampled) |
| `exit-test` | ok (1 sampled) | key_destroyed (1 sampled) |
| `paused-uni` | empty (0 sampled) | empty (0 sampled) |
| `shred-drill-20261027` | key_destroyed (3 sampled) | key_destroyed (3 sampled) |
| `shred-drill-20261028` | key_destroyed (3 sampled) | key_destroyed (3 sampled) |
| `shred-drill-20261029` | key_destroyed (3 sampled) | key_destroyed (3 sampled) |
| `test-poly` | empty (0 sampled) | empty (0 sampled) |
