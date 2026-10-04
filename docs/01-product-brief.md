# 01 — Product Brief

## 1. Vision

**UniVarse is the operating platform for Nigerian tertiary institutions:** one central, multi-tenant system an institution adopts instead of building or stitching together its own. It covers the whole institution (administration, finance, academics, teaching and continuous assessment, student affairs), with **confidentiality, integrity and availability (CIA) as the first design constraint**, not an afterthought.

We aim to make these true:

- A candidate applies, pays, is screened, accepts an offer and becomes a student **without visiting campus for paperwork**.
- A student registers courses, pays fees, takes CA tests, submits assignments, sees results and requests transcripts **from a phone on a weak network**.
- A lecturer runs the course in one place (materials, engagement during lectures, assignments, CA tests) and **CA scores flow straight into the result workflow** (HOD → Dean → Senate) **with a tamper-evident audit trail**.
- **Every consequential action is logged and attributable:** results, payments, authentication, roles, sensitive data access.
- The Registry produces the senate list, transcripts and NYSC list **in minutes, not weeks**. Sessions, carryovers and spillovers are handled without spreadsheets.
- UniVarse onboards a new institution **in days, without writing code**.

### 1.1 Why UniVarse is different

| Today in Nigerian tertiary EdTech | UniVarse |
|---|---|
| Separate vendors for portal, fees, results, LMS and CBT, each with its own logins, data and security posture | **One platform, one identity, one record per student**, built as an *ecosystem of independent products* that work together (§6, principle 8) |
| Integrity depends on people and spreadsheets (grade tampering, forged receipts, "missing results") | **Integrity is built in:** immutable published results, hash-chained audit log, webhook-verified payments, step-up re-authentication for sensitive actions |
| Each institution builds or customises its own system | **Configurable, not custom:** institutions differ by settings, not code forks |
| Portals collapse at peak (registration, results, CBT) | **Capacity for peaks** is a design input, and products are isolated so one product's spike doesn't take down another |

UniVarse **does not replace national bodies** (JAMB, NUC, WAEC, NYSC, TSA/Remita). It integrates with their file formats and processes ([15-integrations.md](15-integrations.md)) so institutions don't have to.

## 2. Problem statement

| Pain today | Consequence | UniVarse answer |
|------------|-------------|-----------------|
| Results compiled in Excel, passed by flash drive and email | Errors, "missing results", grade tampering, months of delay | Structured score sheets, workflow approvals, immutable published results, hash-chained audit |
| Many disconnected vendor portals (admission, fees, results, LMS, CBT) | Students re-enter data, reconciliation hell, inconsistent security | One record per student across the lifecycle. Products share identity and data through contracts |
| CA tests on paper or ad-hoc tools | Slow marking, leaked questions, impersonation, scores re-typed into result sheets | **CA CBT** with randomised papers, integrity logging, auto-marking, and direct flow into score sheets |
| Portals collapse on result day, registration day or test day | Frustration, extended deadlines | Peak-load design, product isolation, caching, queueing, load tests as release gates |
| Default passwords (e.g. surname) and shared accounts | Account takeover, result leaks | Activation via OTP, breached-password checks, MFA for staff with approval powers |
| Fee receipts forged, payments not reconciled | Revenue loss, disputes | Gateway webhooks only, reconciliation jobs, QR-verifiable receipts |
| Technical issues bounce between students, departments and vendors | Nobody owns the problem | **Clear support chain:** institution users → institution IT Admin → UniVarse (§5.3) |
| Transcript requests take months | Graduates lose opportunities | Online request, payment, generation, QR verification, tracked delivery |

## 3. Target customers

| Segment | Notes | Phase |
|---------|-------|-------|
| **Private universities** (≈150) | Fast decisions, smaller (2k–15k students), pay for quality. **Launch market and pilot target** | GA |
| **State universities** | Medium/large, indigene fee rules, state procurement | GA+ |
| **Federal universities** | Large (20k–60k+), TSA/Remita mandatory, formal procurement | GA+ |
| Polytechnics / Colleges of Education | Different regulators (NBTE/NCCE), ND/HND and NCE structures | Post-GA (`tenantType` reserved now) |

Design for the **largest realistic single tenant: 60,000 active students and 3,000 staff**. Peaks to design for:
- **10,000 concurrent users** at result release.
- **2,000 students starting the same CA test in the same minute.**
- **Several hundred concurrent live-lecture participants** per large course.

## 4. Personas and portals

| Persona | Portal / surface | Top jobs |
|---------|------------------|----------|
| **Applicant** | `/apply` | Create account, fill form, upload O'level, pay form fee, check screening status, accept offer, pay acceptance fee |
| **Student** | `/student` | Pay fees, register courses, **course pages, materials, assignments, CA tests, in-lecture engagement**, exam docket, results/GPA, hostel, clearance, transcripts |
| **Lecturer** | `/staff` | Assigned course offerings and class lists. **Course pages and materials, live engagement during lectures, assignments and marking, CA test authoring and question banks**. Enter/upload scores, submit score sheets |
| **Level adviser** | `/staff` | Approve/reject course registrations for their cohort |
| **HOD** | `/staff` | Department broadsheet, approve/return score sheets, allocate courses to lecturers, curriculum, CA test oversight |
| **Dean / Provost** | `/staff` | Faculty board approvals, faculty reports, senate list review |
| **Exams & Records / Registrar** | `/staff` | Senate approval recording, publication, transcripts, certificates, NYSC list |
| **Admissions officer** | `/staff` | Cycles, screening, merit lists, offers, CAPS export |
| **Bursary** | `/staff` | Fee schedules, invoices, payments, waivers, reconciliation, reports |
| **Student affairs / Hostel officer** | `/staff` | Hostel allocation, disciplinary cases, clearance steps |
| **Institution IT Admin (ICT)** | `/staff/admin` | Institution setup, users, roles, imports, settings, integrations, **enabling products**, first-line technical support, liaison with UniVarse (§5.3, §5.4) |
| **Management (VC/DVC)** | `/staff` | Dashboards, KPIs (read-only) |
| **External verifier** | `/verify` (public) | Verify a transcript, certificate or receipt by code/QR |
| **UniVarse platform staff (Super Admin)** | `console.univarse.ng` | Onboard tenants, provisioning, billing, platform health, **support for institution IT Admins** |

The staff surface is **one workspace whose navigation and actions are driven by permissions and scopes**. A person who is Lecturer + HOD + Level Adviser sees one merged experience. There are no separate portals per role.

## 5. Scope

### 5.1 The product suite (in scope for GA, see [18-roadmap.md](18-roadmap.md))

UniVarse is organised as **products** that an institution enables and that work **both independently and together**, like the products in a workspace suite (architecture: [02 §6.1](02-architecture.md), [ADR-020](19-decision-log.md)).

| Product | Covers |
|---|---|
| **Core** (always on) | Identity, roles and MFA · institution structure · academic calendar (sessions, semesters, carryovers, spillovers) · audit · notifications · settings |
| **Admissions** | Cycles, applicant portal, screening, merit lists, offers, CAPS export, enrolment |
| **Bursary** | Fee schedules, invoices, gateway payments, waivers, reconciliation |
| **Academics** | Programmes, curriculum, student records, course registration, exam timetable & dockets, score entry & result workflow, GPA/CGPA & standing, clearance, graduation, transcripts, NYSC export |
| **Teaching & Learning** | Course spaces, materials, announcements, **live lecture engagement** (attendance check-in, polls, Q&A), **assignments** (submission, marking, feedback) |
| **Assessment (CA CBT)** | Question banks, **continuous-assessment tests** (timed, randomised, integrity-logged, auto-marked where objective), scores flowing into score sheets as CA components. **Examinations are excluded** (§5.5) |
| **Student Affairs** | Hostel, disciplinary cases, clearance steps |
| **Helpdesk & Comms** | Tickets, announcements, email/SMS |
| **Reporting** | Role-scoped dashboards, standard and regulatory reports |

### 5.2 Product independence (what "ecosystem" means here)
- **Independent:** an institution can enable Bursary without Teaching & Learning, and so on. A failure, deploy or load spike in one product must not take down another. For example, a CA-test spike must not slow down fee payment.
- **Dependent where it makes sense:** products rely on each other only through **published contracts** (APIs and events). Examples: CA scores → score sheets, payments → registration unlock, enrolment → identity.
- **Consistent:** one identity, one permission model, one audit trail and one design system across all products.

### 5.3 Support and communication chain
- **Institution users** (students, lecturers, staff) report technical issues to **their institution's IT Admin** through the helpdesk. UniVarse staff don't take direct support requests from institution end users.
- **IT Admins ↔ UniVarse (Super Admin)** communicate both ways: IT Admins escalate tickets to UniVarse, and UniVarse sends announcements, incident notices and maintenance windows to IT Admins. Every exchange is logged.
- UniVarse staff can access an institution's data **only** through time-boxed, reason-logged, tenant-visible support access (docs/05 §1).

### 5.4 IT Admin control: reasonable, with guardrails

| IT Admins **can** | IT Admins **cannot** |
|---|---|
| Manage users, roles and role scopes; bulk imports; activations | Read or export secrets (password hashes, MFA secrets, gateway secret keys after save) |
| Configure every institution setting (`[CONFIG]` keys), branding, integrations | Disable or edit the audit log, or bypass tenant isolation |
| Enable or disable products within their plan | Weaken platform security baselines (e.g. MFA for privileged roles, session limits) |
| Run first-line support; approve or deny UniVarse support access | Access other institutions, or platform data beyond their own tenant |
| Export their institution's data (audited, step-up) | Change another institution's or UniVarse staff accounts |

### 5.5 Explicit non-goals and deferred items

**Non-goals (not planned):**
- **Replacing national bodies or their systems** (JAMB/CAPS, NUC, WAEC, NYSC, TSA). UniVarse integrates with them.
- **Holding funds.** UniVarse never collects money on behalf of institutions. Payments settle directly to the institution's gateway account ([15-integrations.md](15-integrations.md)).
- **HR/payroll.** Staff records only as far as academic functions need them.

**Deferred (planned after GA, design hooks kept now):**

| Deferred item | Why deferred | Hook kept now |
|---|---|---|
| **CBT for examinations** (and Post-UTME) | Exams need invigilated venues, stricter lockdown and legal defensibility. CA CBT proves the engine first | The Assessment engine is built exam-capable (sessions, venues, integrity logs). Exams stay on paper or an external vendor, with scores imported |
| **Native mobile apps** (students and lecturers only) | A responsive web app / PWA covers GA. Native apps need a stable API | Mobile-first UI, offline-tolerant flows, token-based auth to be added by ADR (ADR-005 note) |
| **3D virtual labs** for practical-heavy courses (physics, chemistry…) | Content-heavy and specialised | Teaching & Learning supports embeddable interactive content (sandboxed) |
| **Inter-institution access ("campus embassies")**: students of one UniVarse institution taking classes or tests at a nearby UniVarse institution | Needs bilateral agreements, policy and trust frameworks | Federation design principles recorded now (ADR-021) so tenant isolation never has to be weakened later |
| Postgraduate school specifics (thesis supervision, etc.) | Scope | Entry modes modelled generically |

## 6. Product principles

1. **CIA first.**
   - *Confidentiality:* least privilege, tenant isolation enforced by the database, encryption of secrets.
   - *Integrity:* immutable published results, append-only ledgers, a hash-chained audit trail, step-up for sensitive actions.
   - *Availability:* peak-load design, isolated products, tested backups.
   When a feature conflicts with CIA, CIA wins.
2. **Correctness over features.** A wrong GPA, a lost payment or a mis-marked CA test destroys trust permanently. Domain engines are pure, exhaustively tested and fixture-verified.
3. **Everything consequential is logged and attributable.** Who, what, when, why and from where, for scores, test attempts, approvals, payments, roles, authentication and sensitive-data access.
4. **Configurable, not custom.** Institutions differ (grading bands, fees, matric formats, approval stages, CA weights). Differences are **tenant settings**, never forks or `if (tenant === 'X')`.
5. **Built for Nigerian networks and devices.** Low-end Android, intermittent 3G/4G, expensive data. Keep pages light, save drafts, retry safely, resume tests after a dropped connection, make everything printable.
6. **Minimal typing, maximum selection.** Bulk operations, imports with preview, sensible defaults.
7. **Secure by default.** Least privilege, MFA for power users, no shared or default passwords.
8. **Independent products, one ecosystem.** Each product can be enabled, scaled and fail on its own, and interacts with others only through published contracts.
9. **Boring technology.** Proven tools one person plus AI assistance can operate.

## 7. Success metrics

| Metric | GA target |
|--------|-----------|
| Result processing time (exam end → Senate-approved publication) | Reduced ≥50% vs institution baseline |
| CA test turnaround (test end → scores in score sheet) | Objective items: immediate. Mixed: ≤ 3 working days |
| CA-test peak | 2,000 students starting within 60 s, with zero lost answers and error rate < 0.1% |
| Live lecture engagement | Poll/Q&A round-trip p95 ≤ 1 s for 500 concurrent participants |
| Transcript turnaround (request → dispatch) | ≤ 5 working days |
| Availability (monthly) | 99.9% (pilot: 99.5%) |
| p95 API latency (reads / writes) | ≤ 300 ms / ≤ 800 ms |
| Result-day peak | 10k concurrent users per large tenant with error rate < 0.5% |
| Cross-product isolation | A load test saturating one product leaves other products' p95 within SLO |
| Payment reconciliation mismatches unresolved > 48h | 0 |
| Cross-tenant data exposure incidents | 0 (a Sev-1 by definition) |
| Tenant onboarding (contract → live structure & users) | ≤ 10 working days |
| Student task success (register courses unaided; take a CA test unaided) | ≥ 90% in usability tests |

## 8. Business model (assumption, to validate)

- Per-student-per-session subscription, tiered: **Pooled** (standard) and **Dedicated** (own database, custom domain, higher SLA).
- **Products are entitlements** in the plan (e.g. Core + Academics + Bursary, with Teaching & Learning and Assessment as add-ons).
- Onboarding/migration fee for historical data import.
- Optional add-ons: SMS bundles, transcript courier handling, extra storage.
- The platform billing module ([05 §1](05-modules-and-features.md)) tracks plans, subscriptions and platform invoices. It is separate from institution fee collection.
