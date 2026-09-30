# 15 — External Integrations

Every integration sits behind a **port** (TypeScript interface) in the owning module, with one **adapter** per provider and a **fake** adapter for tests/dev. Swapping providers must not touch use cases.

> `[VERIFY]` Provider APIs, fees, formats and regulatory positions change. Before building each adapter, confirm the current official documentation, sandbox availability and commercial terms. Record the doc version/date in the adapter's README.

## 1. Payment gateways (`finance` module)

```ts
interface PaymentGateway {
  initiate(input: { invoice; amountKobo; payer; merchantReference; callbackUrl; metadata }): Promise<{ redirectUrl?: string; inlineConfig?: unknown; gatewayReference?: string }>;
  verify(reference: string): Promise<{ status: 'SUCCEEDED'|'FAILED'|'PENDING'; amountKobo: number; currency: 'NGN'; paidAt?: Date; channel?: string; raw: unknown }>;
  parseWebhook(rawBody: Buffer, headers: Headers): Promise<WebhookEvent>;   // throws on bad signature
  fetchSettlements?(from: Date, to: Date): Promise<SettlementRecord[]>;     // for reconciliation
  refund?(reference: string, amountKobo: number): Promise<RefundResult>;
}
```

| Provider | Typical use | Notes |
|----------|-------------|-------|
| **Paystack** | Private & state institutions: cards, bank transfer, USSD | Inline popup or redirect. Webhook signature `x-paystack-signature` = HMAC-SHA512(raw body, secret). Verify via the transaction verify endpoint. Split/subaccounts optional |
| **Flutterwave** | Alternative/secondary gateway | Webhook `verif-hash` header or signature per the current API version. Verify via the transaction verify endpoint |
| **Remita** | **Federal institutions (TSA)**, some state institutions | Generate an **RRR** per invoice with the institution's service type IDs (`serviceTypeId` maps to fee items/revenue heads). The payer pays online or at a bank using the RRR. Confirm via status query + notification. Hash-based request auth per spec `[VERIFY]` |

**Design rules:**
- **Money never flows through UniVarse.** Each tenant connects its **own** gateway account (keys in `GatewayConfig`, encrypted). Settlement goes straight to the institution. This keeps UniVarse out of payment-service licensing territory `[VERIFY with counsel]`.
- Per tenant: enabled gateways, preferred gateway per fee category, and fee-bearing policy (payer vs institution bears charges).
- Flow: create `PaymentTransaction(INITIATED)` → gateway → user returns to `/payments/{ref}/status` (a polling page) → **webhook or scheduled verify** → credit. Scheduled `verify` sweeps `PENDING` transactions every 5 min for 24h, then daily for 7 days (bank-transfer and RRR payments can be delayed).
- Reconciliation: daily settlement pull (where the API exists) or CSV upload of settlement reports by bursary.
- Test mode: gateway sandbox keys in staging. The fake gateway supports scripted outcomes (success, failure, delayed, duplicate webhook, amount mismatch).

## 2. SMS (`comms` module)

| Provider | Notes |
|----------|-------|
| **Termii** (primary) or **Africa's Talking** | Register a **sender ID** per tenant (e.g. `UNILAG`) where the institution wants one. Sender IDs need approval and take time `[VERIFY]` |
| DND considerations | Transactional/OTP routes to reach numbers on Do-Not-Disturb `[VERIFY]` with the provider |

- Port: `SmsSender.send({ to: E164, body, category: 'OTP'|'TRANSACTIONAL'|'BROADCAST' })`.
- Numbers are normalised to E.164 (`+234…`) with `libphonenumber-js`.
- Cost is tracked per tenant (`OutboundMessage.costKobo`). Per-tenant monthly caps and alerts.
- Broadcast SMS needs the `comms.sms.broadcast` permission and shows a cost estimate before sending.

## 3. Email (`comms` module)

- Provider: Amazon SES / Postmark / Resend (pick one; the port makes it swappable).
- Sending domain: `mail.univarse.ng` with **SPF, DKIM, DMARC (p=quarantine → reject)**. Tenants may later verify their own domain for the from-address.
- Separate streams: transactional (OTP, receipts) vs broadcast (announcements), so broadcast reputation can't hurt OTP delivery.
- Bounce/complaint webhooks mark addresses as undeliverable.
- Templates: MJML → HTML, with a plain-text alternative, tenant branding, and no remote tracking pixels.
- Dev: Mailpit captures all mail.

## 4. JAMB / CAPS (`admissions` module)

- There's **no general public API** for third-party admission systems `[VERIFY]`. The integration is **file-based**:
  - **Import:** candidate lists and UTME/DE data exported from CAPS/JAMB portals (CSV/XLSX) → mapped via a configurable column mapping per cycle (formats change year to year).
  - **Export:** admission recommendation list in the format required for CAPS upload.
  - **Status re-import:** CAPS acceptance/approval statuses back into `AdmissionOffer.capsStatus`.
- Keep a versioned mapping library (`admissions/infrastructure/jamb/mappings/{year}.ts`) with sample files as fixtures.

## 5. O'level result verification (`admissions`)

- Default: **manual verification** workflow (applicant enters grades + uploads the result slip, an officer verifies). Optionally scratch-card details are collected for officers to check on the exam body's portal.
- Optional adapter: WAEC/NECO verification services or licensed aggregators, if the institution subscribes `[VERIFY]` availability & terms.

## 6. Identity verification (optional)

- NIN verification via NIMC-licensed verification partners (e.g. Prembly, Smile ID, VerifyMe) `[VERIFY]`. Store only the verification result + an encrypted NIN. Never store full returned biodata beyond what's needed. Requires a clear lawful basis and notice ([16](16-compliance-ndpa.md)).

## 7. NYSC (`graduation` module)

- Export of the mobilisation (senate) list in the format the NYSC portal requires for institution uploads `[VERIFY each cycle]`. It's a versioned export template, like JAMB mappings.

## 8. Document generation (Gotenberg, internal)

- Templates: HTML + CSS (print), rendered server-side from typed data, then sent to Gotenberg → PDF → stored in object storage with SHA-256 → `IssuedDocument` + QR (`https://{tenant-host}/verify/{code}`).
- Deterministic output (fixed fonts bundled, no remote assets, the timestamp is taken from the data rather than render time), so re-rendering is verifiable.
- Digital signatures (PAdES) on transcripts are `[PHASE 8+]`. For now, integrity comes from QR verification + the stored hash.

## 9. Malware scanning (ClamAV, internal)

- The worker streams the object to `clamd` (INSTREAM). Signatures are updated by `freshclam` in the ClamAV container.
- Scan failures/timeouts → `ERROR` → retried. The file stays unusable until `CLEAN`.

## 10. Future integrations (design hooks now, build later)

| Integration | Hook |
|-------------|------|
| Moodle / Google Classroom (LTI 1.3, rostering) | `registration.approved` events → roster sync |
| Microsoft 365 / Google Workspace student email provisioning | `admissions.applicant_enrolled` → provisioning adapter |
| Library system (Koha) for clearance | `ClearanceStep.autoCheck` adapter |
| Accounting/ERP export | Ledger export in CSV/journal format |
| Outbound tenant webhooks | [06 §12](06-api-guidelines.md) |

## 11. Integration checklist (per adapter)

- [ ] Port + adapter + fake. Adapter README with doc version/date
- [ ] Timeouts (connect 3 s / total 10 s), retries with jitter only for idempotent calls, circuit breaker
- [ ] Secrets from `GatewayConfig`/secret manager. Egress allowlist entry added ([09 §4](09-container-security.md))
- [ ] Webhook signature verification + idempotency + raw-event persistence
- [ ] Metrics (`*_requests_total`, latency, errors) and alerts
- [ ] Sandbox contract test (nightly) + fake-based integration tests
- [ ] Runbook for provider outage
