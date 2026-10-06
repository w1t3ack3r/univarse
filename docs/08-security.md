# 08 — Application Security

**Target baseline:** OWASP ASVS 5.0 **Level 2** for the whole application, and **Level 3** controls for authentication, result integrity and payments. Container and infrastructure hardening is in [09](09-container-security.md). Privacy and regulation are in [16](16-compliance-ndpa.md).

---

## 1. Assets and what "bad" looks like

| Asset | Worst outcome |
|-------|---------------|
| Results (scores, grades, CGPA) | Silent grade tampering, leaked results before approval |
| Money flows | Fake payments credited, double crediting, refunds to attackers |
| Identity & roles | Account takeover of HOD/Registrar/Bursar, privilege escalation |
| Tenant isolation | Institution A reads Institution B's students |
| Personal data | Mass leak of student biodata / NIN (an NDPA breach) |
| Issued documents | Forged transcripts or receipts that pass verification |
| Availability | Portal down on result day or registration deadline |
| Platform control | Compromise of the console → all tenants |

## 2. Threat model (STRIDE, top threats)

| # | Threat | Vector | Primary controls |
|---|--------|--------|------------------|
| T1 | **Cross-tenant data access** | Missing tenant filter, IDOR with another tenant's UUID, job without tenant context | RLS forced on every table, Host-derived tenant, session bound to tenant, CI RLS checker, isolation test suite |
| T2 | **Insider grade tampering** | Lecturer/officer edits after approval, DB edits | State-machine locks, immutable `course_result`, append-only grants, amendment workflow, hash-chained audit, SoD, anomaly alerts |
| T3 | **Account takeover** | Credential stuffing, default passwords, phishing, SIM swap | Argon2id, breached-password check, rate limits/lockout, OTP activation (no default passwords), mandatory TOTP/WebAuthn for privileged roles (not SMS), new-device alerts, session revocation |
| T4 | **Privilege escalation** | Self-granting roles, mass assignment, scope bypass | Role grants need a separate permission + step-up + audit. Strict zod schemas. Scope checks against the resource |
| T5 | **Payment fraud** | Spoofed webhook, manipulated redirect, replay, amount tampering | Signature verification, server-side verify call, amount/currency/reference match, unique gateway reference, idempotency, reconciliation |
| T6 | **Document forgery** | Fake transcripts/receipts | Random verification codes, `/verify` shows the canonical data, SHA-256 stored, revocation |
| T7 | **Injection** | SQL, template, command, CSV/formula injection | Prisma parameterisation. `$queryRaw` only with tagged templates. No shell exec with user input. CSV export escapes `= + - @` |
| T8 | **XSS** | Announcements rich text, names in PDFs | React escaping, server-side sanitisation (DOMPurify/sanitize-html allowlist), strict CSP with nonces, no `dangerouslySetInnerHTML` without a sanitizer wrapper |
| T9 | **Malicious uploads** | Malware, polyglots, huge files, SVG script | Presigned size limits, magic-byte type check, ClamAV, no SVG from users, images re-encoded, files served as attachments from a separate origin |
| T10 | **SSRF** | URL fields (webhooks, logo URL) | No server fetch of user-supplied URLs except via an allowlisted egress proxy. Block private ranges |
| T11 | **DoS on peak days** | Traffic spikes, bots | CDN/WAF, rate limits, caching, autoscaling, waiting room, load-test gates |
| T12 | **Console compromise** | Phished super admin | Separate host, IP allowlist, WebAuthn/TOTP mandatory, short sessions, two-person rule for destructive ops, platform audit |
| T13 | **Supply-chain attack** | Malicious npm package, poisoned image | Lockfile, pnpm `minimumReleaseAge`, build-script allowlist, SCA scanning, pinned image digests, signed images ([09](09-container-security.md)) |
| T14 | **Secrets exposure** | Committed `.env`, logs, error pages | Secret manager, gitleaks pre-commit + CI, log redaction, generic errors |
| T15 | **Result leak before publication** | API returning unpublished results | Students can only read `course_result` (published). Score entries aren't exposed on student endpoints |
| T16 | **CA test question leakage** | Questions or answer keys fetched before the window, shared between candidates, or scraped | Papers are served only inside the window and only to the eligible candidate. The answer key is never sent to the client. Shuffled per-candidate papers from banks. Item exposure stats help retire leaked items |
| T17 | **Test impersonation / collusion** | Someone else sits the test; one person drives several attempts; answers shared live | One active session per attempt (takeover logged, needs lecturer unlock). Optional start photo check. Integrity events (device/IP change, focus loss, paste, timing anomalies) logged append-only for **human** review, with no automatic penalties |
| T18 | **Timer or score manipulation** | Client clock tampering, replaying answers after time-out, editing scores after release | Server-authoritative timer and deadlines. Answers after the deadline are rejected. Idempotent answer writes. Released CA scores change only via the amendment path. Every change is audited (spec 0002) |
| T19 | **One product degrading another** | CA-test or live-lecture spike exhausting shared DB connections or CPU; a noisy tenant | Runtime roles, per-role pools, per-product queues and rate limits, circuit breakers (ADR-020). The cross-product isolation load test is a GA gate |
| T20 | **Live-session abuse** | Attendance code shared off-site; spam or abusive Q&A; poll stuffing | Attendance codes rotate every ≤ 30 s and are bound to the live session. One response per student per poll. Moderated Q&A with per-user rate limits. Every attendance and moderation action is logged |
| T21 | **Over-powerful tenant admin** | A compromised or malicious IT Admin disabling controls | IT Admin guardrails ([01 §5.4](01-product-brief.md)): can't read secrets, alter audit, weaken platform security baselines, or reach other tenants. Privileged + step-up + audited |

Revisit the threat model at the start of every roadmap phase. New modules add rows.

## 3. Authentication

### 3.1 Passwords
- **Argon2id** (`m=19456 KiB, t=2, p=1` minimum, tuned so hashing takes ~100–250 ms on prod hardware). Parameters are stored in the hash for future upgrades, with rehash on login when parameters change.
- Policy (NIST SP 800-63B): minimum **8** characters for students/applicants and **12** for staff, maximum 128, all characters allowed, **no composition rules, no forced rotation**. Reject passwords found in breach corpuses (HIBP k-anonymity API or an offline top-1M list) and context words (institution name, own name, matric number).
- **No default passwords, ever.** Imported users are `PENDING_ACTIVATION` and activate via an OTP sent to their email/phone on record.

### 3.2 MFA
- **Required** for any user holding a permission tagged `privileged` (approvals, finance, role management, settings, exports of personal data) and for all platform staff.
- Factors: TOTP (RFC 6238, secret encrypted), WebAuthn/passkeys `[PHASE 8]`, and 10 single-use recovery codes (hashed).
- SMS OTP is allowed for **activation and password reset of students/applicants only**, never as an MFA factor for privileged users (SIM-swap risk).

### 3.3 Sessions
- 256-bit random session ID. The cookie `__Host-uv_sid` is `Secure; HttpOnly; SameSite=Lax; Path=/`. The server stores only `SHA-256(id)`. Sessions are looked up under the requesting tenant's RLS context, so another tenant's token is simply not found (the membership check). One-time codes are low-entropy, so they are hashed with HMAC-SHA256 using a server-side pepper and limited to 5 attempts.
- Lifetimes `[CONFIG]` within bounds:

| User type | Idle timeout | Absolute |
|-----------|--------------|----------|
| Student / applicant | 60 min | 12 h |
| Staff | 30 min | 10 h |
| Privileged staff | 15 min | 8 h |
| Platform console | 15 min | 8 h |

- Rotate the session ID on login, privilege change and step-up. On password change / MFA change / role revocation, **revoke all other sessions**.
- Max concurrent sessions per user: 5 (oldest evicted). Staff get a new-device login email.
- **Step-up:** actions tagged `@RequireStepUp()` need `session.mfaAt` (or password re-entry for non-MFA users) within 5 min. Examples: approve/publish results, amend results, grant roles, approve waivers/refunds, change payment gateway keys, bulk export personal data, change grading settings.

### 3.4 Brute force & enumeration
- Rate limits ([06 §7](06-api-guidelines.md)). After 5 failures per account: progressive delay. After 10 in 15 min: temporary lock (15 min) plus a notification to the user.
- Identical responses and similar timing for unknown user vs wrong password. Reset/activation responses always say "If an account exists, we've sent a code."
- CAPTCHA (Cloudflare Turnstile) on public forms (applicant signup, password reset) after suspicious volume.

### 3.5 CSRF
- SameSite=Lax cookies, plus the API **rejects state-changing requests** (`POST/PUT/PATCH/DELETE`) unless `Sec-Fetch-Site` is `same-origin`, or (for browsers without Fetch Metadata) `Origin` matches the tenant host. Webhooks are on a separate cookie-less host.

## 4. Authorization

- **Deny by default.** Every route declares a permission. A route with no declaration fails a startup self-check.
- **Permission catalog** in `packages/contracts/permissions.ts`: `<module>.<resource>.<action>`, each tagged with `privileged`, `requiresStepUp` and `sensitiveData` flags.
- **Scopes:** a permission is effective only for resources inside the assignment's scope. The org scope uses the `OrgUnit.path` containment check. Course-offering scope comes from `CourseOfferingStaff`. Cohort scope (level adviser) uses `(programmeId, cohortSessionId)`.
- **Evaluation:** a `PolicyService.can(actor, permission, resourceContext)` pure function, unit-tested with a matrix, backed by a per-session permission cache (invalidated on `identity.role_*` events).
- **Separation of duties (enforced in use cases):**
  - Score sheet submitter ≠ approver at the next stage.
  - Waiver/refund/manual-payment requester ≠ approver.
  - A user can't grant roles to themselves or grant permissions they don't hold.
  - Result amendment requester ≠ final approver.
- **Object-level access for students/applicants:** always derived from the session (`/students/me/...`). Endpoints taking a `studentId` are staff-only and scope-checked.
- 404 (not 403) for out-of-scope objects, to avoid confirming that they exist.

## 5. Input, output and data handling

- Validate **all** input with zod at the edge (type, length, format, range). Normalise Unicode (NFKC) for identifiers and names, trim, and cap lengths (names ≤ 100, free text ≤ 5,000 unless specified).
- Output encoding by React. PDFs are rendered from server-escaped templates. Email templates escape by default.
- **CSV/XLSX exports:** prefix cells starting with `= + - @ \t \r` with `'`.
- **Logging:** never log passwords, OTPs, session IDs, tokens, full NIN, card data or gateway secrets.
  - **How it's enforced:** Pino redaction paths **and** a string scrubber (query strings, header values, cookie values, bearer tokens, signed storage credentials, quoted literals in error text) are configured centrally in `apps/api/src/shared/observability/`, with unit tests for each path and pattern ([spec 0012](specs/0012-observability-logs-and-traces.md) OB4).
  - **Traces:** they're protected separately, because span attributes aren't covered by log redaction (OB5).
- **Error responses:** Problem Details only. No stack traces, SQL or internal hostnames.
- Cardholder data **never** touches UniVarse. Card entry happens on gateway-hosted pages/popups only, which keeps UniVarse out of PCI DSS scope for card data (SAQ-A-style posture).

## 6. HTTP security headers (web + API)

| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic' https://js.paystack.co https://checkout.flutterwave.com …; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://{files-origin}; connect-src 'self'; frame-src https://checkout.paystack.com …; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://…gateways; object-src 'none'; upgrade-insecure-requests` (exact gateway origins `[VERIFY]` per integration) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` (API) |
| `Cache-Control` | `no-store` on authenticated API responses and pages with personal data |

CSP starts in `report-only` mode in staging, reports go to an endpoint, and it's enforced before Phase 3 pilots.

## 7. File uploads

Built in [spec 0010](specs/0010-file-uploads.md).
1. **The upload slot.** The client asks for a slot. The server checks permission and **reserves quota atomically**, then issues a presigned **POST** whose policy fixes the key (`tenants/{tid}/q/{uuid}`), the type, and a `content-length-range`. (`content-length-range` is a POST-policy condition; a presigned PUT can only sign an exact `Content-Length`.)
2. **The scan, in the worker.** It reads the object with a size bound, sniffs the **magic bytes** against the allowlist, then scans with ClamAV.
   - **Allowlist today:** PDF, PNG and JPEG. More types arrive with the modules that need them.
   - **ClamAV runs fail-closed:** `AlertExceedsMax` and `AlertEncrypted*` are on, and the limits sit above the upload size. With the image defaults, a limit hit or an encrypted document comes back as a plain `OK`.
   - **Only an explicit `OK` is clean.** Any detection (`FOUND`) is infected and raises a security event. Timeouts, refusals and odd replies are retried, then `SCAN_FAILED`, never clean.
   - **Clean bytes are promoted from the scanned buffer** to a lease-unique key in a bucket no client can write. A reused upload URL can only create an orphan, which cleanup removes.
3. Images are re-encoded (strips EXIF/GPS and polyglot payloads) and thumbnails generated. PDFs aren't rendered inline on the app origin.
4. **Downloads go through the authenticated API endpoint.** Every download re-checks permission and verifies the SHA-256 before sending any byte. The response is `attachment`, under `nosniff` and a CSP with `sandbox`. Presigned GET URLs or a separate CDN origin are a later option, needing their own spec (they are bearer URLs).
5. Limits: photo 2 MB, document 5 MB, import file 20 MB `[CONFIG]`.

## 8. Payments security (see also [15](15-integrations.md))

- The tenant's gateway secrets are encrypted ([07 §8](07-data-and-database.md)), write-only in the UI, and changing them needs step-up and notifies all institution admins.
- Payment initiation: the server creates the `PaymentTransaction` with **our** reference and amount. The client never supplies the amount.
- Crediting happens only when: verify API says success **AND** amount = expected **AND** currency = NGN **AND** reference matches **AND** the transaction isn't already applied. All of this runs in one DB transaction with a row lock on the invoice.
- Webhook signature verification is mandatory. Unknown/unsigned events are dropped and alerted on.
- Daily reconciliation. Mismatches alert the bursary and appear on the dashboard.
- Refunds and manual payments: two-person approval + step-up + audit.

## 9. Result integrity controls

- The state machine guards every transition server-side. Scores can't be edited outside `DRAFT/RETURNED`.
- `snapshotHash` on each transition, with a verification tool to recompute and compare.
- `course_result` is append-only by grants plus a trigger. Amendments create new rows and supersede old ones via `superseded_by`.
- Anomaly detection (weekly job + alerts):
  - scores changed within 1h of a deadline by users outside the offering staff
  - large grade shifts on resubmission
  - approvals outside working hours in bulk
  - many amendments by one actor
- The audit viewer lets Registry reconstruct the complete history of any grade.

## 10. Secrets management

- **No secrets in git, images, or compose files.** `.env` files exist only locally, are git-ignored, and `.env.example` holds placeholders.
- Prod/staging secrets live in a cloud secret manager (AWS Secrets Manager / GCP Secret Manager / Vault). They're delivered to workloads via External Secrets Operator (k8s) or injected env at deploy time (compose), and rotated at least annually or immediately on suspicion.
- Distinct secrets per environment. Dev secrets are useless in prod.
- DB credentials: separate users per service role ([07 §1](07-data-and-database.md)). Prefer IAM/short-lived credentials where the provider supports them.
- gitleaks runs in pre-commit and CI. A detected secret = rotate first, then clean history.

## 11. Security in the development lifecycle

| Stage | Control |
|-------|---------|
| Design | Threat-model delta for each new module (add rows to §2). Security acceptance criteria in the feature spec |
| Code | Secure coding checklist in the PR template, zod everywhere, lint rules (no raw tenant Prisma, no `eval`, no `dangerouslySetInnerHTML`) |
| CI | SAST (Semgrep + CodeQL), SCA (osv-scanner / `pnpm audit`), secret scan, IaC scan (Checkov/Trivy config), container scan ([09](09-container-security.md)), RLS checker |
| Staging | DAST (OWASP ZAP baseline nightly, full scan before release), authenticated scans per role |
| Pre-GA | **Independent penetration test** (external + authenticated multi-tenant + business logic), with remediation verified |
| Ongoing | Dependency updates weekly (Renovate), monthly patch window, annual pen test, responsible-disclosure policy (`/.well-known/security.txt`) |

## 12. Security monitoring & incident response

- **Security events** go to a dedicated log stream with alerts:
  - login anomalies
  - lockouts
  - cross-tenant session attempts
  - webhook signature failures
  - RLS violations (`permission denied` / `new row violates row-level security policy` errors)
  - privilege grants
  - break-glass sessions
  - mass exports
  - ClamAV detections
- **Severity levels:**
  - **Sev-1**: confirmed data breach, cross-tenant exposure, payment fraud, integrity compromise
  - **Sev-2**: active attack contained, privileged account compromise
  - **Sev-3**: vulnerability without evidence of exploitation
- **IR playbook** (runbook in [14](14-observability-and-operations.md)): detect → triage (≤ 30 min for Sev-1) → contain (revoke sessions/keys, suspend accounts, block IPs, feature-flag off) → eradicate → recover → **notify** (affected tenant controllers without undue delay, contractually ≤ 24h; they notify NDPC within 72h, and we support them) → post-incident review within 5 working days with action items.
- Keep an up-to-date **asset & data inventory** and **contact list** (tenant DPOs, provider support, legal).

## 13. Security checklist for every PR (copy into the PR template)

- [ ] Endpoint declares permission. Scope checked against the loaded resource
- [ ] Tenant data accessed only via `ShardRegistry.forTenant` / `ShardRegistry.tx`
- [ ] zod `strict()` schemas for input. Response DTO mapper for output
- [ ] Sensitive action has `@RequireStepUp()` and an audit event
- [ ] No secrets/PII in logs, errors or analytics
- [ ] Idempotency for creates/payments/bulk
- [ ] Rate-limit category set
- [ ] Tests include an unauthorized path (403/404) and a cross-tenant path
