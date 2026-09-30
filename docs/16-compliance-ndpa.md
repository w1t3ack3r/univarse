# 16 — Privacy & Compliance (NDPA 2023)

> **Not legal advice.** This is the engineering interpretation that shapes the system. Every `[VERIFY]` item must be confirmed with a Nigerian data-protection lawyer / licensed DPCO before the first pilot handles real data. Primary sources: **Nigeria Data Protection Act 2023 (NDPA)** and the **NDPC General Application and Implementation Directive (GAID) 2025**.

## 1. Roles

| Party | NDPA role | Consequence for us |
|-------|-----------|--------------------|
| Institution (tenant) | **Data controller** for its applicants, students and staff | Decides purposes. Responds to data subjects (we provide tools) |
| UniVarse | **Data processor** for tenant data. **Controller** for platform data (tenant contacts, platform staff, billing, marketing site) | Processes only on documented instructions via a **Data Processing Agreement (DPA)** with each tenant |
| Sub-processors | Cloud host, email/SMS providers, Sentry, etc. | Listed publicly. DPAs in place. Tenants notified of changes |

UniVarse is likely a "data controller/processor of major importance" given its scale and the sensitivity of the data, which means **registration with NDPC**, appointing a **Data Protection Officer**, and periodic **compliance audit returns** `[VERIFY]` thresholds and filing schedule under GAID.

## 2. Lawful bases (per processing purpose, controller's decision, our defaults)

| Purpose | Lawful basis (default) |
|---------|-----------------------|
| Admission processing | Contract (pre-contract steps) / legitimate interest |
| Academic records, registration, results, graduation | Contract + legal obligation (regulatory record-keeping) |
| Fees and payments | Contract + legal obligation (financial records) |
| Security logging, fraud prevention | Legitimate interest |
| Health/medical clearance, disability accommodations | **Sensitive data**: explicit consent or a specific legal basis. Access strictly limited |
| Marketing / non-essential communications | Consent (opt-in, withdrawable) |
| NIN verification | Legal obligation/contract only where the institution requires it. Otherwise don't collect |

Minors: some applicants/students are under 18. Show age-appropriate notices and consider parental/guardian involvement where consent is the basis `[VERIFY]`.

## 3. Privacy by design — engineering requirements

| Principle | Implementation |
|-----------|----------------|
| Data minimisation | Every personal field in the schema has a documented purpose (`docs/data-inventory.md`). No religion/ethnicity/tribe fields by default. `[CONFIG]` fields must be justified by the tenant |
| Purpose limitation | Module ownership + permissions. Reporting uses aggregated/pseudonymised views |
| Accuracy | Self-service profile updates (with OTP verification), change-request workflow for official fields |
| Storage limitation | Retention jobs per data class (§5) |
| Integrity & confidentiality | [08](08-security.md), [09](09-container-security.md): encryption, RLS, access control, audit |
| Accountability | Audit logs, DPIAs, records of processing, training, access reviews |
| Transparency | Privacy notice per tenant (template provided, tenant customises), shown at signup/activation, versioned with acceptance recorded |

**Data classification** (tag every field/file):

| Class | Examples | Handling |
|-------|----------|----------|
| PUBLIC | Institution name, programme list | — |
| INTERNAL | Course codes, timetables | Auth required |
| CONFIDENTIAL | Names, matric no., contact, results, invoices | Scope-based access, audit on bulk export |
| SENSITIVE | NIN, health/disability, disciplinary records, next-of-kin, DOB, photos | Encrypted where specified, `view_sensitive` permission, access audited individually, excluded from general exports |

## 4. Data subject rights (tools we must provide)

| Right | Tooling | SLA support |
|-------|---------|-------------|
| Access / portability | "Download my data" (JSON + PDF summary) for students/applicants. Staff-initiated DSAR export | Tenant responds within the statutory period `[VERIFY]` (generally ≤ 30 days) |
| Rectification | Profile edit + change-request workflow | |
| Erasure | Supported where no retention obligation applies (e.g. unsuccessful applicants, marketing data). Academic & financial records are **retained** under legal obligation, and the response explains this | |
| Restriction / objection | Flag to restrict processing (e.g. exclude from broadcasts). Marketing opt-out | |
| Consent withdrawal | Preferences page. Recorded with timestamp | |
| Automated decision-making | Merit lists and standing are **recommendations reviewed by humans**. Explanations are available (aggregate breakdown, rule results) | |

All DSAR actions are logged (`dsar_request` table with status and deadlines).

## 5. Retention schedule (defaults, `[CONFIG]` per tenant within legal bounds)

| Data class | Default retention | Action at end |
|------------|-------------------|---------------|
| Academic record (results, transcripts, graduation, core biodata of students) | Permanent | — |
| Financial records | 6 years after the end of the financial year `[VERIFY]` | Delete/anonymise line-level payer data. Keep aggregates |
| Unsuccessful applicants | 24 months after the cycle | Delete (keep anonymised statistics) |
| Uploaded admission documents of enrolled students | Until graduation + 2 years | Delete, except documents required for the record |
| Medical/health clearance data | Until graduation + 1 year | Delete |
| Disciplinary records | Per the institution's policy (default: graduation + 6 years) | Delete/anonymise |
| Sessions, login attempts, IP logs | 12 months | Delete |
| Application logs | 30 days hot / 12 months cold | Delete |
| Audit events | ≥ 10 years for academic/financial actions | Archive |
| Backups | 35 days PITR, monthly 12 months | Expire. Deleted data disappears from backups at expiry |
| Offboarded tenant | Export delivered, deleted 60 days after offboarding | Purge + certificate of deletion |

Retention jobs are idempotent, log counts (not contents), and run in the `maintenance` queue.

## 6. DPIA (required before pilot)

Scope: large-scale processing of students' personal data including sensitive categories, profiling-like merit ranking, and cross-border hosting if applicable. Deliverable: `docs/compliance/dpia-v1.md` covering data flows, risks (use [08 §2](08-security.md) threats), mitigations, residual risk and DPO sign-off. Revisit on major changes (new sensitive data, new sub-processor, new region).

## 7. Cross-border transfer

If hosting is outside Nigeria ([10 §2](10-infrastructure-and-deployment.md)), document the transfer basis under the NDPA (adequacy, appropriate safeguards / contractual clauses, or another permitted ground) `[VERIFY]`, include it in the DPA and the privacy notice, and offer in-country dedicated hosting to tenants that require it.

## 8. Breach management

- Detection and response per [08 §12](08-security.md).
- **Processor → controller:** notify the affected tenant(s) without undue delay (contractually ≤ 24h after confirmation), with the nature, categories, approximate numbers, likely consequences and measures taken.
- **Controller → NDPC:** within **72 hours** of awareness where the breach is likely to risk data subjects' rights. We supply the information needed. Notify data subjects where there's high risk.
- Keep a **breach register** (including non-notifiable incidents).

## 9. Contractual & organisational artefacts (`docs/compliance/`)

- [ ] Data Processing Agreement template (tenant ↔ UniVarse)
- [ ] Sub-processor list (public page) + change-notification process
- [ ] Privacy notice templates (applicant, student, staff) + platform privacy policy
- [ ] Records of Processing Activities (RoPA)
- [ ] DPIA v1
- [ ] Data inventory (field-level purpose, class, retention)
- [ ] Information security policy, access control policy, acceptable use, incident response plan, BCP/DR plan
- [ ] NDPC registration & DPO appointment records `[VERIFY]`
- [ ] Staff (and future employee) privacy & security training records
- [ ] Annual compliance audit return `[VERIFY]` schedule

## 10. Other regulatory touchpoints

| Area | Note |
|------|------|
| NUC / regulators | Record-keeping and statistical returns. Transcript/certificate authenticity (verification portal) |
| Financial | Institutions' TSA/Remita obligations (federal). UniVarse doesn't hold funds |
| Cybercrimes Act 2015 (as amended) | Incident reporting obligations for certain systems `[VERIFY]` applicability |
| Accessibility | WCAG 2.2 AA as the product standard |
| ISO 27001 / SOC 2 | Not required for GA. Align controls now so certification is achievable post-GA if large customers require it |
