# Spec 0010 — File uploads: upload → scan → authorised download → deletion

**Status:** Accepted (2026-10-06), owner review. D2 and D3 decided; D1 decided **by evidence** (FU11 gates the upload path) · **Phase:** 0 (roadmap: "files: presigned upload, ClamAV scan"; isolation layer 5, the file half) · Builds on [06 §9](../06-api-guidelines.md), [08 §7](../08-security.md), [ADR-025](../19-decision-log.md) (SeaweedFS locally), [spec 0009](0009-api-route-sweep.md) (RS6).
Every AC ID appears in at least one test name.

## Why
Admissions documents, receipts and course materials all need files. This is the first slice: **one real web flow, backed by real storage and real ClamAV**. A person uploads a document, watches it being checked, downloads it, and deletes it.

The flow is built so a file is **never** available before it has been scanned clean, and the bytes downloaded are **exactly** the bytes that were scanned. Uploads close the **file** half of isolation layer 5. The cache half is not covered here: the product cache across instances (spec 0003 P7) stays tracked.

## Terms
- **Quarantine bucket:** where uploads land. Clients can write here only through a presigned URL. Nothing is ever served from it.
- **Clean bucket:** where scanned bytes are written **by the worker**. No presigned URL for it is ever issued. Downloads read only from here.
- **Promotion:** the worker writes the exact bytes it scanned, from its own buffer, to the clean bucket. It never copies the quarantine object (which could have changed since the scan).
- **File states:**
  - `PENDING_UPLOAD`: a slot was issued.
  - `UPLOADED`: the client said it's done.
  - `SCANNING`: claimed by the worker under a lease.
  - Terminal: `CLEAN`, `INFECTED`, `REJECTED` (type or size) or `SCAN_FAILED` (the scanner couldn't decide after retries).
  - `ABANDONED`: never completed.
  - `DELETED`.
- **EICAR:** the industry-standard harmless antivirus test string. On its own it fails our type check, and ClamAV's EICAR signature matches the exact test file, so it can't carry the full-flow detection test (FU16).
- **Test signature:** a harmless marker string, detected by a test-only ClamAV signature database mounted only in dev and CI (FU16).
- **Reservation:** the bytes a file holds against the tenant quota, from slot to release (FU13).

## The flow (first slice)
1. **Ask for a slot.** `POST /api/v1/files/uploads` with `{ name, mime, sizeBytes }`.
   - The server checks permission, the allowlist, the size limit and the tenant quota.
   - It creates the record (`PENDING_UPLOAD`) with a **server-generated key**, `tenants/{tenantId}/q/{fileId}`.
   - It **reserves** the declared size against the quota atomically (FU13).
   - **The upload path (D1, decided by FU11's evidence):**
     - **If SeaweedFS enforces a presigned POST policy's `content-length-range`:** the response is `{ fileId, upload: { url, fields }, expiresAt }`. It is a presigned **POST** with a 5-minute TTL, a policy fixing the exact key, `Content-Type`, and `content-length-range` of 1 to the declared size.
     - **Otherwise:** `{ fileId, uploadPath }`. The browser sends the bytes to `PUT /api/v1/files/{id}/content`, which streams them to quarantine, counting bytes and stopping at the limit. No client ever holds a storage credential.
2. **Upload.** The browser sends the bytes by whichever path FU11 selected.
3. **Finish.** `POST /api/v1/files/{id}/complete`: `PENDING_UPLOAD` becomes `UPLOADED`. The response says "checking".
4. **Scan, in the worker.** The worker claims `UPLOADED` files (lease, `SKIP LOCKED`), then:
   1. reads at most *limit + 1* bytes of the quarantine object into memory;
   2. checks the size and the **magic bytes**;
   3. streams those bytes to clamd (`INSTREAM`).
   - **Clean:** it writes those same bytes to `tenants/{tenantId}/c/{fileId}`, records `sha256`, sets `CLEAN`, then deletes the quarantine object.
   - **Infected:** `INFECTED`; the quarantine object is deleted, and a security event and audit event are written.
5. **Status.** `GET /api/v1/files/{id}` returns the state. The UI polls it, showing "Checking for viruses…".
6. **Download.** `GET /api/v1/files/{id}/content` is **authenticated**. It re-checks permission and state on every request.
   - It reads the clean object with a strict size bound (the recorded size).
   - It verifies the **complete** SHA-256 **before sending any byte**, then sends exactly those verified bytes with safe headers (FU5, FU14).
7. **Delete.** `DELETE /api/v1/files/{id}`: the record becomes `DELETED` (this **wins** over any scan in flight, FU15), the reservation is released once, and both objects are removed. Audited.

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| FU1 | *Tenant and user authorisation.*<br>• **New permissions:** `files.file.upload`, `files.file.read` and `files.file.delete` (D2).<br>• **Own files only:** in this slice a user reaches only their own files. Another user's file, in the same tenant or another, is the same `404 resource.not_found` as a nonexistent id, with no existence oracle.<br>• **Keys and metadata:** object keys are **server-generated** and tenant-prefixed, and never derived from user input. Metadata lives in `file_object` under forced RLS (already in the DB sweep).<br>• **Private buckets:** an anonymous `GET` of any object fails, which the storage contract test proves. |
| FU2 | *RS6 activates now.* `GET /files/:id`, `POST /files/:id/complete`, `GET /files/:id/content` and `DELETE /files/:id` are **resource routes**. They land with spec 0009 declarations and fixtures:<br>• **baseline:** A succeeds on A's own file;<br>• **cross-tenant:** B's file id gives a response identical to a nonexistent id, and B's file is unchanged;<br>• **same tenant:** another user's file also gives 404 (resource-scoped, invariant 2).<br>The record reference is supplied only in the path, and the declaration says so. The sweep's coverage report shows real resource routes **> 0**. |
| FU3 | *Quarantine: never released unscanned.* Only `CLEAN` files can be downloaded; every other state is `404` (or `409 file.not_ready` for the owner, D3). These outcomes **never** produce `CLEAN`:<br>• **Scanner down or timing out:** retried with backoff, then `SCAN_FAILED`. The file stays unavailable, and the owner sees "We couldn't check this file".<br>• **Size-limit refusal from clamd** (`INSTREAM size limit exceeded`), or an unexpected clamd answer: `SCAN_FAILED`.<br>• **Worker crash mid-scan:** the lease expires and the scan restarts from the start.<br>Only an explicit `stream: OK` from clamd allows promotion. |
| FU4 | *The downloaded bytes are the scanned bytes.*<br>**Why:** a presigned upload (PUT or POST) can be **reused** until it expires, and can **overwrite** the quarantine object, including after the scan.<br>**Defences:**<br>• promotion writes the scanned buffer, never a copy of the quarantine object;<br>• the clean bucket has no client write path;<br>• each download verifies the stored SHA-256 before sending, and refuses a mismatch (FU14);<br>• the quarantine object is deleted after a decision. A reused URL that recreates it leaves an orphan, which cleanup removes (FU7).<br>**Tests:**<br>• an overwrite with EICAR **during** the scan, and another **after** promotion: the downloaded bytes equal the original clean bytes, by SHA-256;<br>• a direct tamper of the clean object fails the download. |
| FU5 | *Content validation, limits and safe headers.*<br>• **Allowlist (D3):** PDF (`%PDF-`), PNG (`89 50 4E 47 0D 0A 1A 0A`) and JPEG (`FF D8 FF`), detected from the **actual bytes**. The declared MIME and the file name's extension must agree with the detected type, otherwise `REJECTED` with reason `type_mismatch` or `type_not_allowed`.<br>• **Size:** per-file limit 5 MB (docs/08 §7). It is checked at the slot, enforced in transit (the POST policy's `content-length-range`, or the API's byte counting, per D1), and checked again on the actual bytes.<br>• **Tenant quota:** a new setting, `files.storageQuotaBytes` (spec 0007 registry, core product, `settings.tenant.manage`). Declared sizes are **reserved** at the slot and released when a file becomes `ABANDONED`, `REJECTED` or `DELETED`.<br>• **Download headers:** `Content-Type` from the **detected** type; `Content-Disposition: attachment; filename*=UTF-8''<sanitised name>`; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: sandbox; default-src 'none'`; `Cache-Control: private, no-store`; `Cross-Origin-Resource-Policy: same-origin`. |
| FU6 | *Download semantics.*<br>• **Downloads go through the authenticated endpoint**, which re-checks the session, permission, ownership and state on **every** request. No presigned GET URL is issued in this slice.<br>• **If presigned GETs are ever added** (for large files or a CDN), the spec adding them must state their nature: they are **bearer URLs**. Anyone holding one can download until it expires, and permission changes don't reach them before expiry.<br>• **Revocation is coarse, not absent.** On AWS, a presigned URL stops working when the credentials that signed it stop working: an expired temporary session, or a deactivated or deleted key. That cuts off **every** URL those credentials signed, not one link. The spec adding direct downloads must test and document the **actual** behaviour of the backend in use. |
| FU7 | *Recovery is idempotent.*<br>• **Scanning:** the result is written conditionally on `(id, state = SCANNING, lease)`; a re-run produces the same decision and the same clean key.<br>• **Cleanup** (a worker job):<br>  – `PENDING_UPLOAD` older than the URL TTL plus a margin becomes `ABANDONED`, and its quarantine object is deleted;<br>  – quarantine objects with no live record, such as those from reused URLs, are deleted;<br>  – the quota is released.<br>• **Deletion:** the record is marked `DELETED` first, then the objects are removed. A crash in between is finished by cleanup. Deleting twice is safe. |
| FU8 | *Audit (invariants 6, 12).* Files are `CONFIDENTIAL`, so **each download is audited**. In the same transaction as each state change, these events are written:<br>• `files.upload.requested`;<br>• `files.upload.completed`;<br>• `files.scan.clean` / `files.scan.infected` / `files.scan.rejected` / `files.scan.failed` (system actor);<br>• `files.downloaded`;<br>• `files.deleted`.<br>Detections also raise a security event for humans; nothing is auto-punished (invariant 12). |
| FU9 | *Real web flow.*<br>• **Page:** "My documents" (nav by permission). Upload with a picker; status rows ("Checking for viruses…", "Ready", "Blocked: this file contained a virus", "Not accepted: only PDF, PNG or JPEG up to 5 MB", "We couldn't check this file"); a download link; delete with inline confirmation.<br>• **Upload progress:** shown while the file uploads; a refresh mid-upload resumes the status.<br>• **Quality:** designed with the impeccable skill; axe-clean; E2E on desktop and mobile against **real SeaweedFS and ClamAV**. |
| FU10 | *Evidence against real services.* Integration and E2E tests run against SeaweedFS and ClamAV in compose and in CI, covering:<br>• a clean PDF, PNG and JPEG;<br>• EICAR (`INFECTED`);<br>• a type mismatch and an oversize file;<br>• the scanner stopped (`SCAN_FAILED` after retries, never `CLEAN`), and a scanner timeout;<br>• a worker crash mid-scan (lease expiry, then a re-scan);<br>• concurrent overwrites (FU4);<br>• cross-tenant and other-user access (FU2);<br>• concurrent quota reservations (FU13), a tampered clean object (FU14), and delete-during-scan (FU15);<br>• an abandoned upload cleaned up.<br>**EICAR and the test marker are built at run time from parts**, never stored as files. A stored copy would be quarantined by Windows Defender on dev machines, and flagged in the repository. |
| FU11 | *Storage contract tests (ADR-025), and the D1 gate.* A test against **real SeaweedFS** records the backend's actual behaviour for:<br>• **a presigned POST whose policy has `content-length-range`: is an upload over the limit refused?** This decides D1. Enforced: direct POST. Not enforced, or not supported: the API upload path, and the result is recorded here;<br>• a presigned PUT reused before expiry (overwrite allowed?);<br>• `If-None-Match: *` on PUT;<br>• a signed `Content-Length` mismatch;<br>• expiry enforcement;<br>• an anonymous read of a private bucket.<br>The results are written into this spec. Apart from the D1 gate, the design's safety doesn't depend on any of them (FU4). The same tests run against the production provider before staging. |
| FU13 | *Concurrent uploads can't bypass the quota.*<br>• **Atomic reservation:** a slot reserves its declared size **atomically**, under a per-tenant lock. The reserved total counts every file holding a reservation: pending, uploaded, scanning and clean.<br>• **Released exactly once:** release (on rejection, infection, scan failure, abandonment or deletion) is a conditional update that zeroes the file's reservation, so each reservation is released **exactly once**. Retries and duplicate jobs release nothing twice.<br>• **Tests:** N parallel slot requests that together exceed the quota yield exactly the requests that fit, never over. After every release path, the reserved total equals the sum of the live files' sizes. |
| FU14 | *Downloads are verified before any byte is sent.* The endpoint:<br>1. reads the clean object with a strict bound (it stops one byte past the recorded size);<br>2. computes the **complete** SHA-256;<br>3. compares it with the record;<br>4. only then sends **those same verified bytes**.<br>**On a mismatch:** no byte is sent. The answer is `500 server.internal`, and an integrity event is logged. The test tampers with the clean object directly and asserts that the response carries none of its bytes. |
| FU15 | *Deletion wins against an in-flight scan.*<br>• **Conditional result write:** a scan result is written only if the file is still `SCANNING` under the same lease and not deleted. A late result, or a retried job, **never** restores a deleted file.<br>• **Clean-up after losing the race:** if the worker has already promoted bytes when it loses, it deletes the clean object it wrote; anything left over is removed by cleanup (FU7).<br>• **Reservation:** the quota is released once, by the deletion.<br>• **Test:** delete while the scan is held mid-way. The file stays `DELETED`, no clean object remains, and the reserved total drops by exactly the file's size. |
| FU16 | *Real malware detection through ClamAV.*<br>• **Scanner wiring:** EICAR sent straight to clamd through our scanner client is `FOUND`, which proves the client and the daemon.<br>• **Full flow:** a **valid PDF** carrying the test marker passes the type check, so only ClamAV can stop it. It ends `INFECTED`, recording the **signature name ClamAV reported** (the test signature's own name). That proves the detection came from ClamAV and not from our validation.<br>• **Plain EICAR through the upload flow:** `REJECTED` (`type_not_allowed`). It's tested separately, so that path isn't mistaken for scanner evidence.<br>• **EICAR embedded in a PDF:** the observed ClamAV result is recorded as a contract observation, not relied on. |
| FU17 | *Enrolment-only sessions stay restricted (D2).* The file routes are **not** on the spec 0001 M8 allow-list. A restricted session gets `403 auth.mfa_enrolment_required` on every one of them, which the spec 0009 RS2 exact-set check proves automatically. |
| FU12 | *Local resource budget, measured, not assumed.* With the full stack running, the peak memory of each container, ClamAV included, is **measured**:<br>• at idle;<br>• during a scan burst;<br>• during a **signature reload** (`RELOAD`, which briefly holds two databases).<br>The results are documented in docs/10, with the Docker memory allocation recommended from them. ClamAV's own guidance (about 4 GB for its container) is the starting assumption. The "8 GB for Docker" figure is replaced by the measurement.<br>**Bandwidth is documented too.** The `stable` image ships with signatures, but FreshClam still updates them at start and daily (usually small diffs, sometimes a full database). So the image size is **not** a total download budget. For slow links, FreshClam can be disabled locally, at the cost of stale signatures; it is never disabled in CI or deployed environments. |

## Design notes
- **Schema** (tenant DB, expand-only migration):
  - `file_object` gains `state` (the lifecycle above, replacing the coarse `scan_status`, which is kept and mapped until a later contract), `detected_type`, `rejection_reason`, `scan_attempts`, `lease_until`, `quarantine_key`, `clean_key`, `deleted_at`.
  - `sha256` (exists) is the clean bytes' hash.
  - The `(tenant_id, …)` uniques and RLS stay as they are.
- **Storage config:**
  - `S3_ENDPOINT`, `S3_REGION`, `S3_QUARANTINE_BUCKET`, `S3_CLEAN_BUCKET`, `S3_PUBLIC_ENDPOINT` (the origin the browser uploads to, D1).
  - The app's storage credentials are limited by bucket policy where the backend supports it. The API can presign PUTs to quarantine only; the worker can read quarantine and write clean.
- **Scanner:** clamd over TCP (`INSTREAM`), with a connect timeout, a scan timeout, and an explicit parser for `OK`, `FOUND`, and everything else (treated as an error). clamd's `StreamMaxLength` is set above our per-file limit, so a refusal can only mean a misconfiguration, and fails closed.
- **Worker loop:** a third loop beside the outbox and the key sweep. Each tenant is handled under RLS (like the outbox), with a batch of 5 and a lease of 2 minutes. Backoff per attempt is 10 s, 30 s, 2 min, 5 min, then `SCAN_FAILED`.
- **Web:** the upload uses `fetch`.
  - **Direct POST path:** the CSP `connect-src` allows exactly `S3_PUBLIC_ENDPOINT`, and bucket CORS allows exactly the tenant web origins, `POST` only.
  - **API path:** same origin, so no CSP or CORS change.
- **Quota lock:** `pg_advisory_xact_lock(hashtext('files-quota:' || tenant_id))` inside the slot transaction, then `SUM(reserved_bytes)` against the setting. `reserved_bytes` lives on `file_object` and is zeroed on release.
- **Test signature:** `infra/compose/clamav/test-sigs/univarse-test.ndb` holds a hex body signature for the marker, under a name prefixed `UniVarse.Test`.
  - **Delivery:** a one-shot `clamav-test-sigs` container mounts the fixture **read-only**, copies it into ClamAV's own database volume, and exits. ClamAV never sees the repository file.
  - **Alongside the normal databases:** the official ones (`main`, `daily`, `bytecode`) stay loaded and updated.
  - **Where it runs:** dev and CI only, never any deployed configuration. The marker itself is assembled in the test at run time.
- **No marker-specific application logic.** The API and worker handle ClamAV's ordinary `<signature> FOUND` reply, whatever the signature. Only the scanner knows the test marker exists. The recorded signature name is data, never a branch.
- **Docs to correct when this lands:**
  - docs/06 §9 and docs/08 §7 (download through the authenticated endpoint, not a 302 to a presigned GET);
  - docs/08 §7's `content-length-range`, which is a presigned **POST** policy feature; a presigned **PUT** can only sign an exact `Content-Length`.
  - docs/10: FreshClam bandwidth, and the measured resource budget (FU12).

## Contract and scanner observations (2026-10-06, local; SeaweedFS 4.48, ClamAV 1.5.4, signatures 28136 of 2026-09-27)
| Behaviour (FU11) | Observed | Relied on? |
|---|---|---|
| Presigned POST, exactly at `content-length-range` | 204, stored | **Yes: D1** |
| Presigned POST, limit + 1 byte / 4× the limit | 400, nothing stored | **Yes: D1** |
| Presigned POST to a key other than the policy fixes | 403, nothing stored | Yes (keys are server-generated) |
| Presigned POST **reused** before expiry | 204, **overwrote** | No. FU4 makes it harmless |
| Presigned PUT reused | 400, first object kept | No (the PUT path isn't used) |
| `If-None-Match: *` on an existing key | refused, 412 | No (defence in depth only) |
| Presigned URL after expiry | 403 | Yes (5-minute TTL) |
| Anonymous read of a private bucket | 403 | Yes (FU1) |

| Scanner input (FU16), sent straight to clamd (rechecked after FreshClam updated to 28144, 2026-10-05) | Result |
|---|---|
| A clean PDF | `OK` |
| Exact EICAR (68 bytes; with CRLF) | `Eicar-Test-Signature FOUND` / `Eicar-Signature FOUND` |
| **EICAR embedded in a PDF** | **`OK`: not detected.** This confirms that EICAR can't prove full-flow detection |
| A PDF carrying the test marker | `UniVarse.Test.Marker-1.UNOFFICIAL FOUND` |

## Decisions (owner, 2026-10-06)
- **D1: the upload path, decided by evidence (2026-10-06): presigned POST, direct to storage.** SeaweedFS 4.48 enforces the policy's `content-length-range`:
  - exactly the limit: `204`, stored;
  - one byte over: `400`, nothing stored;
  - four times over: `400`, nothing stored.

  The contract test (FU11) keeps asserting this. If it ever fails, for example against another backend, uploads must switch to the API path before release.
- **D2: who may upload.** Everyone, for their own files, through explicit permissions (`files.file.upload`, `files.file.read`, `files.file.delete`) granted to every seeded role. MFA enrolment-only sessions stay restricted (FU17).
- **D3: limits.** PDF, PNG and JPEG; 5 MB per file; 1 GiB per institution by default (a setting). The owner sees `409 file.not_ready` with the state while a file isn't clean; everyone else gets 404.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Image re-encoding (EXIF/GPS strip, polyglots) and thumbnails (docs/08 §7.3) | First feature that shows images inline |
| More types (webp, csv, xlsx) | The modules that need them (imports, admissions) |
| Sharing, staff access and owner types | Admissions/records modules |
| Presigned GET downloads or CDN | Only if size or traffic needs it, with FU6's bearer semantics |
| Per-tenant storage encryption keys (SSE with tenant keys) | Dedicated-tier work, alongside spec 0006 per-tenant KEKs |
| Storage contract tests against the production provider | Before staging (spec 0008) |
| Cache half of isolation layer 5 (product cache across instances, spec 0003 P7) | With the shared invalidation bus |
