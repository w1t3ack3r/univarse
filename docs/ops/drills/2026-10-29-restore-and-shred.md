# Restore and shred drill, 2026-10-29

Written by `pnpm stack:drill` (spec 0020 B2-11), for the owner to commit. It holds slugs, ids, counts, hashes and times only.

| | |
| --- | --- |
| Set | `20261029T000435Z-956a` |
| Release | `releases/2026-10-27-c0c1cb0.json` |
| Target | the set's position 0/38000060 |
| Tools | `13dabc8` |
| RTO | 84 s, from the first unseal to the last check |
| RPO reached | 154.2 min: the newest shipped WAL segment's age when the restore began |
| Peak memory | 114 MiB, the restore's containers together |

## The drill (D11)

- **Tenant:** `shred-drill-20261029` (`01a184f9-0069-7a2c-8654-33d683776fd9`), suspended, with key version 1 and 3 encrypted values.
- **Destroyed** through the protocol (`pnpm stack:keys destroy`), op `d33c3da6-530c-4ddd-a8d1-87961e67e0e0`, **after** the set was taken: the set holds its keys.
- **Before recovery (the control):** ok (3 sampled).
- **After recovery:** key_destroyed (3 sampled).
- **It leaves, by design:** a suspended tenant with destroyed keys, and one accepted destruction in the ledger.

## The checks (D10)

| Check | Result | Detail |
| --- | --- | --- |
| files | PASS | 0 objects written through the filer, each read back over S3 with its SHA-256 equal |
| migrations and RLS | PASS | migrate --check-only: no pending migration, rls:check passes |
| audit chains at the checkpoint | PASS | every chain verifies, and holds its recorded head |
| row counts | PASS | equal to the set's, platform and 6 tenants |
| data keys unwrap | PASS | 6 of 6 |
| recovery | PASS | the ledger's destructions made to hold |
| control: decryption before recovery | PASS | 3 empty, 2 key_destroyed, 1 ok |
| decryption after recovery | PASS | 3 empty, 3 key_destroyed |
| data keys unwrap after recovery | PASS | 5 of 5 |
| audit chains after recovery | PASS | every chain verifies, with recovery's own events |
| the real ledger unchanged | PASS | its heads are as before |

## Decryption, per tenant

| Tenant | Before recovery | After recovery |
| --- | --- | --- |
| `demo-uni` | empty (0 sampled) | empty (0 sampled) |
| `paused-uni` | empty (0 sampled) | empty (0 sampled) |
| `shred-drill-20261027` | key_destroyed (3 sampled) | key_destroyed (3 sampled) |
| `shred-drill-20261028` | key_destroyed (3 sampled) | key_destroyed (3 sampled) |
| `shred-drill-20261029` | ok (3 sampled) | key_destroyed (3 sampled) |
| `test-poly` | empty (0 sampled) | empty (0 sampled) |
