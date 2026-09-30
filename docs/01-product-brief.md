# 01 — Product Brief

## 1. Vision

Give every Nigerian tertiary institution a **reliable, secure and genuinely usable** digital backbone. Replace paper, spreadsheets, queues and ad-hoc portals with one system where:

- a candidate applies, pays, is screened, accepts an offer and becomes a student **without visiting campus for paperwork**;
- a student registers courses, pays fees, sees results and requests transcripts **from a phone on a weak network**;
- a lecturer enters scores once, and they flow through HOD → Dean → Senate **with a full, tamper-evident audit trail**;
- the Registry produces the senate list, transcripts and NYSC list **in minutes, not weeks**;
- UniVarse onboards a new institution **in days, without writing code**.

## 2. Problem statement

| Pain today | Consequence | UniVarse answer |
|------------|-------------|-----------------|
| Results compiled in Excel, passed by flash drive and email | Errors, "missing results", grade tampering, months of delay | Structured score sheets, workflow approvals, immutable published results, hash-chained audit |
| Many disconnected vendor portals (admission, fees, results) | Students re-enter data, reconciliation hell | One record per student across the lifecycle |
| Portals collapse on result day / registration day | Frustration, extended deadlines | Capacity planning for spikes, caching, queueing, load tests as release gates |
| Default passwords (e.g. surname) and shared accounts | Account takeover, result leaks | Activation via OTP, breached-password checks, MFA for staff with approval powers |
| Fee receipts forged, payments not reconciled | Revenue loss, disputes | Gateway webhooks only, reconciliation jobs, QR-verifiable receipts |
| Transcript requests take months | Graduates lose opportunities | Online request, payment, generation, QR verification, tracked delivery |

## 3. Target customers

| Segment | Notes | Phase |
|---------|-------|-------|
| **Private universities** (≈150) | Fast decisions, smaller (2k–15k students), pay for quality. **Pilot target** | GA |
| **State universities** | Medium/large, indigene fee rules, state procurement | GA+ |
| **Federal universities** | Large (20k–60k+), TSA/Remita mandatory, formal procurement | GA+ |
| Polytechnics / Colleges of Education | Different regulators (NBTE/NCCE), ND/HND and NCE structures | Post-GA (`tenantType` reserved now) |

Design for the **largest realistic single tenant: 60,000 active students and 3,000 staff**, with **10,000 concurrent users** in a result-release spike.

## 4. Personas and portals

| Persona | Portal / surface | Top jobs |
|---------|------------------|----------|
| **Applicant** | `/apply` | Create account, fill form, upload O'level, pay form fee, check screening status, accept offer, pay acceptance fee |
| **Student** | `/student` | Pay fees, register courses, print exam docket, view results/GPA, apply for hostel, clearance, request transcripts |
| **Lecturer** | `/staff` | See assigned course offerings, class lists, enter/upload scores, submit score sheets |
| **Level adviser** | `/staff` | Approve/reject course registrations for their cohort |
| **HOD** | `/staff` | Department broadsheet, approve/return score sheets, allocate courses to lecturers, curriculum |
| **Dean / Provost** | `/staff` | Faculty board approvals, faculty reports, senate list review |
| **Exams & Records / Registrar** | `/staff` | Senate approval recording, publication, transcripts, certificates, NYSC list |
| **Admissions officer** | `/staff` | Cycles, screening, merit lists, offers, CAPS export |
| **Bursary** | `/staff` | Fee schedules, invoices, payments, waivers, reconciliation, reports |
| **Student affairs / Hostel officer** | `/staff` | Hostel allocation, disciplinary cases, clearance steps |
| **Institution admin (ICT)** | `/staff/admin` | Institution setup, users, roles, imports, settings, integrations |
| **Management (VC/DVC)** | `/staff` | Dashboards, KPIs (read-only) |
| **External verifier** | `/verify` (public) | Verify a transcript, certificate or receipt by code/QR |
| **UniVarse platform staff** | `console.univarse.ng` | Onboard tenants, provisioning, billing, support, platform health |

The staff surface is **one workspace whose navigation and actions are driven by permissions and scopes**. A person who is Lecturer + HOD + Level Adviser sees one merged experience. There are no separate portals per role.

## 5. Scope

### In scope for GA (see [18-roadmap.md](18-roadmap.md))
Platform console and tenant lifecycle · Identity, RBAC with scopes, MFA · Institution structure · Programmes and curriculum · Academic calendar · Admissions (UTME & DE) · Bursary (fees, invoices, gateway payments, waivers, reconciliation) · Student records · Course registration · Exam timetable & dockets · Score entry & result workflow · GPA/CGPA engine & academic standing · Clearance · Graduation list · Transcripts & verification · NYSC list export · Hostel · Notifications (email, SMS, in-app) · Helpdesk · Reports · Audit.

### Explicit non-goals (for GA)
- **LMS** (course content, assignments, quizzes). Integrate with Moodle/Google Classroom later instead.
- **Holding funds.** UniVarse never collects money on behalf of institutions. Payments settle directly to the institution's gateway account (see [15-integrations.md](15-integrations.md)).
- **HR/payroll.** Staff records only as far as academic functions need them.
- **Native mobile apps.** A responsive web app / PWA is enough for GA.
- **Postgraduate school specifics** (thesis supervision, etc.). Model entry modes so it can be added later.
- **Computer-based testing (CBT)** for Post-UTME. Import scores from the CBT vendor.

## 6. Product principles

1. **Correctness over features.** A wrong GPA or a lost payment destroys trust permanently. Domain engines are pure, exhaustively tested and fixture-verified.
2. **Configurable, not custom.** Institutions differ (grading bands, fees, matric formats, approval stages). Differences are **tenant settings**, never forks or `if (tenant === 'X')`.
3. **Every consequential change is attributable.** Who, what, when, why and from where, for scores, approvals, payments, roles and records.
4. **Built for Nigerian networks and devices.** Low-end Android, intermittent 3G/4G, expensive data. Keep pages light, save drafts, retry safely, make everything printable.
5. **Minimal typing, maximum selection.** Bulk operations, imports with preview, sensible defaults.
6. **Secure by default.** Least privilege, MFA for power users, no shared or default passwords.
7. **Boring technology.** Proven tools one person plus AI assistance can operate.

## 7. Success metrics

| Metric | GA target |
|--------|-----------|
| Result processing time (exam end → Senate-approved publication) | Reduced ≥50% vs institution baseline |
| Transcript turnaround (request → dispatch) | ≤ 5 working days |
| Availability (monthly) | 99.9% (pilot: 99.5%) |
| p95 API latency (reads / writes) | ≤ 300 ms / ≤ 800 ms |
| Result-day peak | 10k concurrent users per large tenant with error rate < 0.5% |
| Payment reconciliation mismatches unresolved > 48h | 0 |
| Cross-tenant data exposure incidents | 0 (a Sev-1 by definition) |
| Tenant onboarding (contract → live structure & users) | ≤ 10 working days |
| Student task success (register courses unaided) | ≥ 90% in usability tests |

## 8. Business model (assumption, to validate)

- Per-student-per-session subscription, tiered: **Pooled** (standard) and **Dedicated** (own database, custom domain, higher SLA).
- Onboarding/migration fee for historical data import.
- Optional add-ons: SMS bundles, transcript courier handling, extra storage.
- The platform billing module ([05 §1](05-modules-and-features.md)) tracks plans, subscriptions and platform invoices. It is separate from institution fee collection.
