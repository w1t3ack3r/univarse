# Spec 0014: Job isolation — the file-scan worker and the key sweep (cross-tenant suite, layer 4)

**Status:** Implemented (2026-10-13); met once reviewed and green in CI.
**Phase:** 0. It closes the "Job isolation" item of [docs/18](../18-roadmap.md) ("cross-tenant claim tests for the file-scan worker and the key sweep") and moves layer 4 of [docs/12 §3](../12-testing-strategy.md) from partial to complete for today's jobs.
**Builds on:**

- [docs/12 §3](../12-testing-strategy.md) layer 4: "a job enqueued for A processes only A's data (assert via a spy on the tenant context)";
- [spec 0004](0004-isolation-sweep.md): the DB isolation sweep;
- the outbox's B8 claim test (`apps/api/src/shared/outbox/outbox.int.spec.ts`), which these tests mirror;
- [spec 0010](0010-file-uploads.md): the file-scan worker, FU3–FU16;
- [spec 0006](0006-envelope-encryption.md): the key sweep, E7 and E9.

**Tests only. No schema change and no production behaviour change.** If a test exposes a real cross-tenant leak, the fix is in scope and is recorded here.

## Why

Layers 1–3 are complete. Layer 4 covers the outbox worker only. The two other background jobs that touch tenant data have no cross-tenant claim test:

- the **file-scan worker**, which claims uploads, reads quarantine objects, writes clean objects, writes audit rows, and cleans up storage by key prefix;
- the **key sweep**, which claims a re-encryption request from the platform database, then rewrites a tenant's encrypted columns.

A job has none of the protections a request has. There is no `Host`, no session and no route table. Its tenant comes from a database row it claimed, so isolation rests on two things: the job running each unit of work inside the **right tenant's context**, and RLS refusing everything else.

## The tenant-context spy

Both jobs reach tenant data only through `ShardRegistry.tx(shardId, tenantId, …)` and `ShardRegistry.forTenant(…)`. The tests wrap those methods on the worker's own `ShardRegistry` instance, passing calls through unchanged and recording the `tenantId` of every call. "Processes only A's data" then means three things:

- every tenant-context call during A's unit of work names A;
- every row written belongs to A;
- every object touched lies under A's prefix.

## Acceptance criteria

| ID  | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JI1 | _File scan: claim._ Tenants A and B each have an uploaded file awaiting a scan.<br>• A scan pass for A claims and finishes **only A's file**; B's stays `UPLOADED`, with no lease and no attempt counted.<br>• **Every** tenant-context call during A's pass names A (the spy).<br>• A pass for B then finishes B's file.                                                                                                                                            |
| JI2 | _File scan: attribution._ After the two passes:<br>• each file's audit rows carry **its own** tenant;<br>• each clean object lies under **its own** tenant's prefix (`tenants/<id>/…`);<br>• A's log lines carry A's `tenantId` (spec 0012 OB2).                                                                                                                                                                                                                     |
| JI3 | _File scan: cleanup stays in its tenant._ B holds an orphan quarantine object (no live record) and a dead file whose objects remain.<br>• `cleanup` for A removes **none** of B's objects and clears **none** of B's keys;<br>• `cleanup` for B then removes them;<br>• every tenant-context call during A's cleanup names A.                                                                                                                                        |
| JI4 | _File scan: RLS is the backstop._ Under A's tenant context, B's `file_object` rows are **invisible**, and the worker's claim statement with **B's id substituted in its tenant filter** claims **nothing**. Isolation doesn't rest on the `WHERE tenant_id` clause alone.                                                                                                                                                                                            |
| JI5 | _Key sweep: claim._ Scratch tenants A and B each hold encrypted values, and **both** DEKs have been rotated.<br>• Only A has a pending sweep request: a sweep pass claims **A's request**, re-encrypts **every one of A's** values onto A's new version, and leaves **every one of B's** values byte-for-byte unchanged, on B's old version.<br>• Every tenant-context call during the pass names A.<br>• B's values are swept only once B's own request is claimed. |
| JI6 | _Key sweep: one request, one tenant._ With requests pending for both tenants, each pass claims exactly one request, and its work (values changed, the completion recorded, the spy's calls) is **all** that request's tenant's. Every value of both tenants still decrypts, under its own tenant's key, afterwards.                                                                                                                                                  |
| JI7 | _Key sweep: RLS is the backstop._ Under A's tenant context, every registered encrypted column's `lockStale` for **B's id** returns nothing, and its `swap` for one of B's rows changes **0** rows. A wrong tenant argument can't reach B.                                                                                                                                                                                                                            |
| JI8 | _Evidence._ Every JI ID appears in a test name. The mutation checks are recorded with their failing test:<br>• the claim filter pointed at the other tenant;<br>• the spy assertion removed;<br>• the cleanup prefix widened.<br>docs/12 §3.1 layer 4 and docs/18 are updated.                                                                                                                                                                                       |

## Design notes

- **Scratch tenants for the key sweep,** as in `key-rotation.int.spec.ts`: `OFFBOARDING` tenants with their own data keys, so no resolver or outbox delivery runs. The seeded tenants' keys are never rotated.
- **The seeded demo/poly tenants for the file scan,** as in `files.int.spec.ts`, against real SeaweedFS and real ClamAV (clean PDFs only; no EICAR is needed).
- **"Byte-for-byte unchanged"** compares B's stored ciphertexts before and after A's sweep. Readability alone could hide a re-encryption onto the wrong tenant's key, which would then fail to decrypt.
- **Out of scope:** product-cache invalidation and key-forget propagation (layer 5, the next item), and new job types. Each new job type must add its own claim test (docs/12 §3.1).

## Implementation evidence (2026-10-13)

**Tests:**
- `apps/api/src/modules/files/file-scan.isolation.int.spec.ts`, 5 tests: JI1, JI2 (two), JI3, JI4. Real SeaweedFS and ClamAV, the seeded demo and poly tenants.
- `apps/api/src/shared/crypto/key-sweep.isolation.int.spec.ts`, 3 tests: JI5, JI6, JI7. Real Vault, scratch tenants.

**Two spies, both pass-through, on the worker's own instances:**
- **Tenant context:** `ShardRegistry.tx` and `forTenant` record the tenant of every call.
- **Storage:** `FileStorage.put`, `remove`, `listKeys` and `readBounded` record every key touched, with the log context's tenant at that moment.

**Checked per pass,** whatever the pass claimed, including other suites' leftovers:
- **Key sweep:** every tenant-context call of a sweep pass names the tenant of the request it claimed.
- **File scan:** every call and object of a scan pass belongs to that pass's tenant.

**Results, local run on 2026-10-13:**
- **JI1:** demo's pass finishes only demo's upload. Poly's file is unchanged: `UPLOADED`, no lease, same attempt count, same `updated_at`.
- **JI2:**
  - audit rows carry their own tenant and are absent from the other tenant's context;
  - clean objects lie under their own prefix;
  - in the **production pass** (`runOnce`) across both tenants, every storage operation runs under the log context of the tenant whose prefix it touches.
- **JI3:** demo's cleanup leaves poly's orphan quarantine object and its dead file's object in place; poly's own cleanup removes them.
- **JI4:** under demo's context, poly's files are invisible, and the worker's claim statement with poly's id in its filter claims nothing. Control: under poly's own context, the same row is claimable.
- **JI5:** with both DEKs rotated and only A's request claimable, A's values all move to `v2:2`, and B's ciphertexts are **byte-for-byte unchanged** on `v2:1`. B is swept only by a later pass for B.
- **JI6:** each pass does only its own request's work, and every value of both tenants decrypts afterwards.
- **JI7:** under A's context, every registered column's `lockStale` and `swap` with B's id reach none of B's rows. Control: under B's own context, they do.

**Together:** with `files.int.spec.ts` and `key-rotation.int.spec.ts`, 4 files and 48 tests pass.

**One fixture fault, fixed:** the first JI3 fixture marked a file `DELETED` without releasing its reservation, and the schema's `file_object_deleted_released` check refused it. That's the constraint working, not a finding; the fixture now matches what a real delete leaves.

**Mutation checks** (JI8), each confirmed to fail its intended test and then restored:

| Mutation | Caught by |
|---|---|
| Key sweep: the pass resolves the wrong tenant (a request for A sweeps the newest scratch tenant) | JI5, JI6 |
| Key sweep: a stray tenant-context call that changes no data | JI5, JI6 (the spy). **With the spy assertion removed, all three pass**: only the spy sees this class |
| Key sweep: every explicit `tenant_id` filter removed from the column operations | **Survives, as intended**: JI7 still passes because RLS alone keeps B out. The first JI7 draft asserted "returns nothing" and failed here, because A's own rows came back; it now asserts "none of B's rows", which is the claim |
| File scan: the claim runs under another tenant's context | JI1, JI2, JI4 |
| File scan: a stray tenant-context call | JI1, JI2, JI4 (the spy). **With the spy assertion removed, all five pass** |
| File scan: the orphan-cleanup prefix widened from `tenants/<id>/q/` to `tenants/` | JI2 (the production pass), JI3: demo's cleanup would delete poly's objects |

**Harness note:** the setup's warm-up drain doesn't assert the spies, so a broken worker fails the intended test, not `beforeAll`. A first version did assert there; two mutations then surfaced as "5 skipped" instead of naming their tests.

**Not changed:** production code. No test exposed a cross-tenant leak.
