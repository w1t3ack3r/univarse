# UNIVARSE
# BILLING AND SUBSCRIPTION POLICY

**Document Type:** Product, Commercial and Technical Policy  
**System:** UniVarse  
**Policy Domain:** Institutional Billing, Subscriptions, Payments and Entitlements  
**Document:** BP-1, version 1.1 (2026-11-10)  
**Status:** Policy baseline, approved by the owner. Implementation follows the roadmap: [spec 0030](specs/0030-institution-billing.md) is the build specification and is amended to match this policy; this document remains the reference for everything the spec doesn't cover.  
**Intended Audience:** UniVarse Product, Engineering, Finance and Implementation Teams  
**Document Purpose:** Establish the definitive commercial rules, billing principles, subscription lifecycle and technical requirements governing how UniVarse will charge institutions for using its services.

---

# 1. INTRODUCTION

## 1.1 Purpose

This document establishes the official billing and subscription policy for UniVarse.

UniVarse is a cloud-based, multi-tenant educational technology platform designed to provide universities and other eligible educational institutions with centralized digital solutions for managing their academic and administrative operations.

As UniVarse grows, its commercial model must provide a predictable, transparent and sustainable revenue structure while ensuring that institutions are charged fairly according to their actual usage, subscribed services and selected products.

This policy defines:

- Institutional onboarding and setup fees.
- Student-based subscription charges.
- Programme-based subscription charges.
- Core and optional product subscriptions.
- Semester-based billing cycles.
- The continuous student count and billing eligibility.
- Invoice generation and management.
- Full and installment payment arrangements.
- Payment verification and reconciliation.
- Subscription renewals and cancellations.
- Product entitlements and access management.
- Billing administration, authorization and auditability.
- Technical and security requirements for the future billing system.

The policy is intended to serve as the authoritative reference for the eventual design and implementation of UniVarse Billing.

## 1.2 Scope

This policy applies to all institutions subscribing to UniVarse and all internal UniVarse personnel involved in managing institutional subscriptions, pricing, invoicing, payment processing and financial administration.

It covers the commercial relationship between UniVarse and its institutional customers.

It does not define the institution's internal tuition collection, student fee payments, departmental financial management or other financial operations unless those capabilities are separately introduced as products under UniVarse.

## 1.3 Product and Hosting Model

UniVarse operates as a centrally managed, cloud-hosted Software-as-a-Service (SaaS) platform.

Institutions subscribe to UniVarse and access its services through their respective tenant environments.

UniVarse retains responsibility for operating and maintaining the underlying application infrastructure.

This policy does not introduce an on-premises deployment model.

Where enterprise requirements justify dedicated infrastructure or isolated resources, such arrangements may be offered as separately agreed cloud-hosted services. Such arrangements do not change UniVarse's centrally managed SaaS operating model.

---

# 2. BILLING PRINCIPLES

All billing and subscription operations must follow these principles.

## 2.1 Transparency

Institutions must understand what they are being charged for.

Every invoice must clearly identify the applicable billing components, quantities, rates, adjustments and total amount payable.

No institution should be charged for an optional product that it has not requested and activated under an approved subscription arrangement.

## 2.2 Usage-Based Fairness

Recurring charges must reflect the institution's agreed subscription structure and eligible usage.

UniVarse will not impose a minimum recurring subscription fee.

The recurring institutional subscription will be calculated using the applicable student count, programme pricing tier, activated optional products and usage-priced services.

## 2.3 Commercial Predictability

Institutions must have access to their applicable pricing arrangements and billing schedules.

Pricing changes must not silently alter previously issued invoices or existing contractual obligations.

## 2.4 Financial Integrity

Invoices, confirmed payments, payment allocations and credit adjustments must be independently traceable.

The system must never treat an unsuccessful payment attempt as a completed payment.

## 2.5 Tenant Isolation

An institution must only access its own billing information.

Central UniVarse finance personnel may access cross-institution billing information only through explicitly authorized administrative permissions.

## 2.6 Auditability

All financially significant operations must generate appropriate audit records.

This includes pricing changes, closing a semester's count, invoice generation, payment verification, payment allocation, subscription activation, cancellations, adjustments and administrative overrides.

## 2.7 Separation of Responsibilities

The academic system, billing system, payment integration and entitlement system must maintain distinct responsibilities.

- The academic system manages students, academic registrations and programmes.
- The billing system determines what an institution owes.
- The payment system records and verifies what an institution has paid.
- The entitlement system determines which UniVarse products and services an institution is permitted to access.

These responsibilities must not be unnecessarily combined into one subsystem.

---

# 3. INSTITUTIONAL ONBOARDING AND ONE-TIME SETUP FEE

## 3.1 Setup Fee Requirement

Every institution subscribing to UniVarse must pay a one-time onboarding and setup fee before production activation.

This fee covers the initial preparation and configuration of the institution's tenant environment.

## 3.2 Setup Fee Coverage

The onboarding fee may cover:

1. Institutional profile creation and configuration.
2. Initial academic structure setup.
3. Faculty, department and programme configuration.
4. Initial institutional administrator setup.
5. Initial system configuration.
6. Standard onboarding and administrative assistance.
7. Initial data preparation and migration where included in the agreed onboarding package.
8. Initial production activation.

The exact onboarding deliverables must be documented in the institution's onboarding agreement.

## 3.3 Additional Services

Substantial custom data migration, specialized integrations, bespoke configuration or other work outside the standard onboarding package may attract additional charges.

Such charges must be communicated and approved separately before the work begins.

## 3.4 Payment and Activation

The setup fee is a one-time charge.

The standard onboarding sequence is:

1. Institution submits a subscription request.
2. UniVarse reviews and approves the institution.
3. The applicable onboarding fee is established.
4. An onboarding invoice is issued.
5. The institution makes payment.
6. Payment is verified.
7. Onboarding and configuration are initiated.
8. Production activation is completed after the required onboarding conditions are satisfied.

An institution must not be considered fully production-active merely because it has created an account or submitted a payment attempt.

No deposit is required. Once the setup fee is paid, the institution's semester charges are invoiced after the semester they cover (Section 8). Optional products are the exception: each is paid before it's switched on (Section 6).

## 3.5 No Repeated Setup Fee

The onboarding fee must not automatically recur every semester.

It must not be charged again simply because an institution renews its subscription, begins a new academic session or enters another semester.

Any substantial new service requiring a separate implementation engagement must be quoted independently.

---

# 4. STUDENT-BASED SUBSCRIPTION MODEL

## 4.1 Pricing Structure

UniVarse will charge institutions based on the number of eligible registered students.

The student subscription is calculated using an agreed rate per eligible student per semester.

The student-based component is therefore:

**Student Subscription = Eligible Student Count × Agreed Per-Student Rate**

The applicable rate is determined by the institution's approved pricing agreement.

## 4.2 Billable Student Eligibility

The billing engine must not simply count all user accounts created within an institution.

The number of billable students must be derived from trusted academic registration records.

A student is eligible for billing when the student satisfies the agreed billing eligibility criteria in that semester (Section 4.3).

The eligibility definition must be documented and consistently applied.

The following must not automatically count as billable students:

- Applicants who have not completed the required admission and registration process.
- Incomplete student registrations.
- Duplicate student records.
- Students whose only registration was cancelled within the standing period.
- Non-student user accounts, including lecturers, administrators and other staff.
- Other records that do not satisfy the institution's approved billable-student definition.

A student must not be counted more than once for the same semester.

## 4.3 The Continuous Semester Count

UniVarse counts billable students **continuously**, every day, from the start of the semester to its **official end**, as the institution defines it in its academic calendar.

A student is billable for a semester when they hold at least one course registration in that semester that has stood for at least **14 days** (a setting). A registration cancelled within those 14 days does not count.

**Late registrations are included in the semester they happen.** There is no census date after which a registration stops counting for its own semester.

Each day:

1. A tenant-side job reads the institution's registrations.
2. It evaluates eligibility using the agreed rules.
3. It writes only the **counts** to the platform's billing records: never who the students are.
4. The institution's authorised staff see the count so far, and the bill it would produce, in their workspace.

## 4.4 The Semester Count Snapshot

At the official end of the semester, the count is **closed** and a snapshot is taken. Once finalized, it is immutable.

The snapshot preserves:

- Institution identifier.
- Academic session and semester.
- The semester's official end date, and when the snapshot was taken.
- Eligible student count.
- The eligibility rule version applied.
- A fingerprint (a hash) of the list of students it counted, so the list can later be shown to match.
- Finalization details, the authorized finalizing actor, and audit metadata.

**The snapshot never holds students' identities.** The list behind a count stays in the institution's own database, where its authorised staff can open it to check the count or support a dispute. UniVarse's platform staff see numbers only.

A finalized snapshot must never be silently overwritten or recalculated in a way that changes an issued invoice. Where a genuine error is discovered, it is corrected through the dispute, adjustment and credit-note process. The original snapshot remains available for audit.

## 4.5 Students Not Yet Charged

Counting continues after a semester closes, so that **no student is charged twice and none is missed**.

- A student whose 14 days complete **after** the semester's official end (because they registered in its last days) is not on that semester's invoice. They are carried forward and charged once, as an adjustment line on the **next** semester's invoice.
- A student already charged for a semester is never charged for it again, however many registrations they hold.
- The billing system keeps, for each student, whether and on which invoice they were charged for each semester, as a reference inside the institution's database, so carried-forward students can be shown.

## 4.6 Student Count Disputes

An institution may request a review of a semester's finalized student count where it believes the count is inaccurate.

A dispute must include a reason and relevant supporting information.

An authorized UniVarse finance or billing administrator must review the request.

Approved corrections must be recorded through an auditable adjustment process.

The original count snapshot and invoice history must remain preserved.

---

# 5. PROGRAMME-BASED SUBSCRIPTION MODEL

## 5.1 Pricing Structure

UniVarse will use a tier-based programme subscription model.

Institutions will be charged according to the applicable programme-count tier rather than a purely linear charge for every individual programme.

The purpose is to provide predictable pricing while allowing institutions with different academic structures to subscribe fairly.

## 5.2 Programme Definition

For billing, a **programme** is a formally approved academic qualification or course of study offered by the institution, with its own defined curriculum and admission requirements, leading to a recognised academic award.

Examples, each one programme where the institution offers it as a distinct qualification:

- B.Sc. Computer Science, B.Sc. Cybersecurity, B.Sc. Mathematics
- B.Eng. Civil Engineering, B.Sc. Nursing Science
- M.Sc. Information Technology, MBA, Ph.D. Computer Science
- HND Accountancy, ND Electrical Engineering

| Academic structure | Counts as a programme? |
|---|---|
| Faculty of Science | No |
| Department of Computer Science | No |
| B.Sc. Computer Science | Yes |
| B.Sc. Cybersecurity | Yes |
| 100 Level or 200 Level Computer Science | No |
| A course (for example, Data Structures) | No |
| A specialization | Not automatically |
| Full-time and part-time versions of the same degree | Normally no |
| Different admission cohorts | No |
| First and second semesters | No |

**Example.** A Faculty of Computing with a Department of Computer Science (B.Sc. Computer Science, B.Sc. Cybersecurity, B.Sc. Software Engineering) and a Department of Information Technology (B.Sc. Information Technology) has **four** billable programmes: not two departments or five levels.

**Rules for the billing engine:**

1. **Unique identity:** every programme has a unique institutional identifier.
2. **Department independence:** moving a programme to another department does not create a new billable programme.
3. **Cohort independence:** admission years and levels do not multiply the count.
4. **Delivery-mode independence:** full-time, part-time and distance versions of one qualification count once, unless the institution's approved structure makes them distinct qualifications.
5. **Specializations:** counted only if formally recognized and managed as a distinct programme under the agreed definition.
6. **Status:** only programmes that meet the active and eligible criteria are counted. Archived, discontinued or merely proposed programmes are not.

UniVarse keeps two concepts apart:

- **Academic programme:** every programme the institution manages academically.
- **Billable programme:** an academic programme that meets the commercial eligibility rules.

An institution can keep the records of a discontinued programme without that programme attracting a charge.

## 5.3 Programme Pricing Tiers

Programme pricing will be configurable through centrally managed pricing tiers.

Illustrative tier structure:

| Tier | Programme Count |
|---|---:|
| Starter | 1–10 |
| Growth | 11–25 |
| Professional | 26–50 |
| Enterprise | 51–100 |
| Custom | Above 100 |

These ranges illustrate the intended tier-based model. The actual thresholds, tier names and monetary prices must be established in the approved pricing catalogue before commercial deployment.

Custom arrangements may be approved for institutions whose requirements exceed the standard tiers.

## 5.4 Tier Calculation

The programme count is taken at the semester's official end, with the student count (Section 4.4): the billable programmes active at that date. It is snapshotted in the same way, as numbers only.

The applicable tier charge appears on that semester's invoice.

Programme tiers must be centrally configurable without application code changes.

## 5.5 Tier Upgrades

Where an institution's programme count exceeds its current tier threshold, the system must identify the change.

The institution must receive appropriate notification.

A tier upgrade that increases the subscription price must not be silently imposed.

The new charge must take effect according to the agreed subscription and billing terms, ordinarily from the next billing period, with the institution informed and any required approval obtained.

## 5.6 Tier Downgrades

Where an institution's programme count decreases, the system may identify eligibility for a lower tier.

However, a downgrade must not occur automatically based on temporary inactivity or an unverified change in programme records.

The change must be evaluated against the agreed programme-count checkpoint and applicable subscription terms.

## 5.7 Billing Frequency

Programme tier charges will follow the institution's agreed recurring subscription cycle.

The standard UniVarse subscription model is semester-oriented. Any alternative cycle must be explicitly documented in the institution's commercial agreement.

---

# 6. CORE AND OPTIONAL PRODUCTS

## 6.1 Product Structure

UniVarse will organize its services into two categories:

1. Core products.
2. Optional products.

The distinction determines whether a product is included in the institution's core subscription or attracts an additional subscription charge.

## 6.2 Core Products

Core products are included in the institution's base UniVarse offering.

Institutions must not be charged an additional optional-product subscription fee for functionality classified as core.

The core product catalogue must be centrally managed.

Changes to the core product offering must be communicated appropriately and must not silently alter existing commercial agreements.

**The core products** (the owner, 2026-11-11), all covered by the per-student rate:

- **Core** (the platform: identity, roles, settings, audit).
- **Academics** (programmes, student records, registration, results, transcripts).
- **Bursary** (fees, invoices, payments to the institution).
- **Admissions** (cycles, the applicant portal, screening, offers). Its applicants are still charged by use (Section 7.4).
- **Helpdesk & Comms** (tickets, announcements, email). SMS is still charged by use (Section 7.4).

## 6.3 Optional Products

Optional products are additional UniVarse services that institutions may choose to activate.

Each optional product must have a defined commercial price and subscription arrangement.

**The optional products** (the owner, 2026-11-11):

- **Teaching & Learning**, with UniVarse Live (its extra hours charged by use, Section 7.4).
- **Assessment** (CA CBT).
- **Student Affairs** (hostel and accommodation, disciplinary cases, clearance steps).
- **Reporting** (dashboards and returns).

Future products are optional unless a decision makes them core. Listing a product here is not a commitment that it is available yet.

## 6.4 Optional Product Activation

Optional products are **paid for in advance**, immediately before they're switched on:

1. The institution views the product, its description and its semester price.
2. It submits an activation request.
3. UniVarse validates and approves the request.
4. A product invoice is issued for the current semester.
5. The payment is verified.
6. The entitlement is activated.

Submitting a request, or a payment attempt, does not grant access. Only a verified payment does.

## 6.5 Optional Product Billing

Each optional product has a **flat fee per semester for each programme tier** (Section 5.3), not a per-student rate (the owner, 2026-11-11). Within a tier the fee is the same for every institution; a larger tier pays more, so a small college doesn't pay a university's price.

Its product invoice is separate from the semester invoice (Section 9), and it is paid in full: installments are for the semester invoice.

The system keeps a separate subscription record for each institution-product relationship.

## 6.6 Optional Product Renewal

An optional product renews semester by semester.

Before each semester begins, the institution is told which optional products will renew, and each one's product invoice for that semester is issued. The product stays on through that semester only once its renewal is paid. Renewal follows the grace and escalation terms of Section 11.

UniVarse must not make unauthorized charges or silently introduce new commercial obligations.

## 6.7 Optional Product Cancellation

An institution may cancel an optional product before its next renewal.

Where cancellation is valid:

- The product stays accessible through the semester already paid for.
- No renewal invoice is issued for the next semester.
- The cancellation is recorded, and the entitlement ends at the end of the paid semester.

Cancellation must not erase data created through the product. Data retention, export and deletion follow UniVarse's data governance and retention policies.

## 6.8 Product Catalogue Management

The product catalogue must be centrally configurable.

Each product record should support:

- Unique product identifier.
- Product name.
- Description.
- Product classification: Core or Optional.
- Pricing information.
- Billing frequency.
- Availability status.
- Activation requirements.
- Renewal terms.
- Cancellation terms.
- Product version or configuration history.

Product pricing and availability must not be hardcoded into application logic.

---

# 7. MINIMUM SUBSCRIPTION POLICY

## 7.1 No Minimum Recurring Subscription Fee

UniVarse will not impose a minimum recurring subscription fee on institutions, and will not set one per contract.

The recurring subscription amount will be calculated from the applicable commercial components:

- Eligible registered students.
- Programme pricing tier.
- Activated optional products.
- Services priced on use (Section 7.4).
- Other separately agreed recurring or one-time charges.
- Approved discounts and credits.

## 7.2 Commercial Implication

The absence of a minimum subscription does not mean that an institution can use UniVarse without applicable charges.

Institutions remain responsible for:

- The one-time onboarding fee.
- Applicable student-based subscription charges.
- Applicable programme tier charges.
- Activated optional product charges.
- Charges for services priced on use.
- Other approved charges under their commercial agreement.

## 7.3 Sustainability

UniVarse may introduce different pricing tiers, institutional packages or commercial arrangements as its customer base grows.

However, such arrangements must remain transparent and must not introduce an undisclosed minimum recurring subscription fee contrary to this policy.

Any future policy amendment must be formally approved and communicated.

## 7.4 Services Priced on Use

Some services have running costs driven by use, and are charged by use on the semester invoice:

- **Admissions:** per applicant in an admission cycle (applicants are not students yet).
- **UniVarse Live:** an allowance of hours per student, then a rate per extra hour.
- **SMS:** at cost plus a margin.

Each is counted by the product that drives it, as numbers only, in the same way as the student count.

## 7.5 Free and Discounted Use

- **The pilot institution:** its first session is free, invoiced at ₦0 with a 100% discount line, so the record exists.
- **Training sandboxes:** never billed.
- **Small institutions:** a lower price for small institutions is kept in the pricing catalogue.
- **Core:** always included.

---

# 8. SUBSCRIPTION BILLING CYCLE

## 8.1 Standard Billing Period

The standard recurring billing cycle for UniVarse institutional subscriptions is semester-based.

Each semester constitutes a distinct billing period.

Student-based charges, applicable programme tier charges and active optional product charges must be associated with the appropriate semester.

## 8.2 Count and Invoice Timing

**The semester's charges are invoiced after the semester they cover.** Optional products are paid in advance, on their own invoices (Section 6.4).

1. The semester begins, and the continuous count starts.
2. Students register, late registrations included; the institution sees the count and the running bill.
3. The semester reaches its official end.
4. The student and programme counts are closed and snapshotted.
5. The charges are calculated.
6. The invoice is issued, a set number of days after the official end (default 14).
7. The institution pays in full, the default, or under an approved installment arrangement.
8. Payments are verified and reconciled.
9. Subscriptions and entitlements continue according to the payment and credit terms.

## 8.3 Billing Period Records

Each billing period must have a unique identifier and be associated with:

- Institution.
- Academic session.
- Semester.
- Start date.
- End date.
- Official end date.
- Billing status.
- Applicable pricing agreement.
- Invoice references.

A billing period must not be confused with a payment transaction or an institution's overall subscription status.

---

# 9. INVOICE MANAGEMENT

## 9.1 Invoice Generation

Invoices must be generated from approved subscription agreements, finalized count snapshots and applicable product subscriptions.

The system must calculate the charges using the commercial terms applicable to the institution and billing period.

## 9.2 Standard Invoice Components

A semester subscription invoice may contain:

1. Student-based subscription charge.
2. Students carried forward from the previous semester (Section 4.5).
3. Programme tier charge.
4. Charges for services priced on use.
5. Other approved recurring charges.
6. Separately agreed additional services, where applicable.
7. Approved discounts.
8. Approved credits or adjustments.
9. Applicable taxes, where legally required.

Optional products are not on the semester invoice: each has its own product invoice, paid before it's switched on (Section 6.4).

The one-time onboarding fee must ordinarily be issued as a separate onboarding invoice.

## 9.3 Invoice Calculation Formula

The standard semester invoice calculation is:

**T = (S × Rs) + Pt + ΣUj + C − D**, then tax

Where:

- **T** = Total invoice amount, before tax.
- **S** = Finalized eligible student count, including students carried forward.
- **Rs** = Agreed rate per eligible student, per semester.
- **Pt** = Applicable programme tier charge.
- **Uj** = Each service priced on use.
- **C** = Other approved charges.
- **D** = Approved discounts and credits.

Each line is computed in kobo, as an integer, and rounded to the kobo, half up, on its own.

Applicable taxes must be calculated and presented separately or incorporated as required by the approved tax treatment.

The formula does not include the one-time onboarding fee unless that fee is explicitly included in a separate onboarding invoice.

## 9.4 Invoice Immutability

Once issued, an invoice must preserve its original:

- Invoice number.
- Institution.
- Billing period.
- Line items.
- Quantities.
- Unit prices.
- Discounts.
- Taxes.
- Total amount.
- Currency.
- Issue date.
- Due date.
- Applicable pricing references.

An issued invoice must not be silently recalculated because pricing or subscription records later change.

Corrections must be handled through controlled adjustments, credit notes or voiding and reissuing where legally and operationally appropriate.

## 9.5 Invoice Statuses

The billing system should support the following invoice states:

- Draft.
- Issued.
- Partially Paid.
- Paid.
- Overdue.
- Void.
- Written Off.

Every status transition must be authorized and auditable.

An invoice must not be marked Paid until sufficient verified payment has been allocated to it.

## 9.6 Invoice Access

Institutional administrators with the appropriate billing permissions must be able to:

- View invoices.
- Download invoices.
- View invoice line items.
- View payment status.
- View outstanding balances.
- Access receipts.
- Raise billing disputes.

Invoices must be isolated by institution.

---

# 10. PAYMENT POLICY

## 10.1 Supported Payment Methods

UniVarse will support both:

1. Full invoice payment.
2. Approved installment payments.

Full payment is the default settlement method.

Installments are available upon request and approval by the UniVarse Finance Team.

## 10.2 Full Payment

An institution may settle the entire invoice amount in one transaction.

Once the payment is independently verified and successfully allocated to the invoice, the invoice may be marked Paid.

## 10.3 Installment Payments

Institutions may request permission to settle an invoice in installments.

Installment payment is not automatic and must be approved by an authorized UniVarse finance representative.

An approved installment arrangement must contain:

- Invoice reference.
- Total invoice amount.
- Approved installment structure.
- Number of installments.
- Amount due per installment.
- Due dates.
- Payment status of each installment.
- Approval record.
- Applicable grace and escalation terms.

The payment plan does not change the original invoice total.

It only establishes an approved schedule for settling the outstanding obligation.

## 10.4 Installment Tracking

Each installment must be tracked independently.

The system must be able to identify:

- Pending installments.
- Paid installments.
- Partially settled installments, where permitted.
- Overdue installments.
- Failed payment attempts.
- Remaining outstanding balance.

A missed installment must be marked overdue and handled according to the approved grace-period and escalation policy.

## 10.5 Payment Provider Integration

UniVarse must support a payment-provider abstraction so that payment integrations can be added, replaced or maintained without coupling the entire billing domain to a single provider.

Paystack and Flutterwave are potential Nigerian payment integrations, but the final provider selection is a separate commercial and technical decision.

The integration must support:

- Secure payment initiation.
- Payment references.
- Transaction verification.
- Webhook processing.
- Signature verification.
- Idempotent event handling.
- Transaction reconciliation.
- Failure handling.
- Payment receipts.

The system must never rely solely on a browser redirect or client-side success message to confirm payment.

## 10.6 Payment Verification

A payment must only be considered successful after independent verification through the payment provider's trusted server-side verification mechanism or another approved authoritative payment channel.

Webhook notifications must be authenticated and validated.

Duplicate webhook delivery must not create duplicate payments or duplicate invoice allocations.

## 10.7 Payment Attempts Versus Confirmed Payments

The system must maintain a strict distinction between payment attempts and confirmed payments.

A payment attempt may be:

- Initiated.
- Pending.
- Successful.
- Failed.
- Abandoned.
- Expired.

A confirmed payment must have an independently verified transaction record.

Failed, abandoned, pending or expired attempts must never be treated as completed payments.

## 10.8 Payment Allocation

Verified payments must be allocated to the appropriate invoice or invoices.

Each allocation must preserve:

- Payment reference.
- Invoice reference.
- Institution.
- Allocated amount.
- Allocation timestamp.
- Allocation actor or process.
- Reconciliation details.

The system must prevent duplicate allocation of the same payment amount.

Where a payment exceeds the amount due, the excess must be handled through an approved credit or refund process rather than silently discarded.

## 10.9 Currency and Financial Precision

NGN will be the initial operational currency for the Nigerian institutional market.

The billing architecture should support future currency expansion without redesigning its fundamental financial model.

All monetary values must be stored using integer minor units or an appropriate exact decimal representation.

Floating-point arithmetic must not be used for financial calculations.

For NGN, amounts should be represented consistently in kobo where integer minor-unit storage is used.

---

# 11. PAYMENT DEFAULTS AND GRACE PERIODS

## 11.1 Overdue Payments

Where an invoice or approved installment passes its due date without sufficient verified payment, the relevant obligation must be marked overdue.

The institution must receive appropriate notifications.

## 11.2 Grace Period

UniVarse must support configurable grace periods.

The applicable grace period must be defined in the institution's commercial agreement or approved billing configuration.

It must not be arbitrarily changed for an institution without appropriate authorization and notification.

## 11.3 Escalation

The system must support an escalation process for overdue obligations.

This may include:

1. Initial payment reminder.
2. Overdue notification.
3. Finance-team follow-up.
4. Administrative escalation.
5. Application of approved service restrictions where contractually permitted.

## 11.4 Service Restrictions

Service restrictions must be controlled, documented and proportionate.

UniVarse must not compromise the integrity or availability of institutional academic records simply because an invoice is overdue.

Any restriction must follow the approved contractual and operational policy.

The entitlement system must support product-level decisions rather than relying exclusively on a single global institution status.

## 11.5 Approved Installment Arrangements

An institution with an approved installment arrangement must be treated according to its agreed credit terms.

The existence of an outstanding balance must not automatically invalidate an approved installment arrangement.

A missed installment may trigger the agreed overdue and escalation process.

---

# 12. SUBSCRIPTION LIFECYCLE MANAGEMENT

## 12.1 Institutional Subscription Lifecycle

An institution's commercial lifecycle should support the following stages:

1. Subscription Request.
2. Institutional Review.
3. Approval.
4. Onboarding Invoice.
5. Payment Verification.
6. Onboarding.
7. Production Activation.
8. Active Subscription.
9. Semester Invoice, after each semester.
10. Suspension, where authorized and necessary.
11. Termination.

Each transition must be subject to the relevant business rules and authorization requirements.

## 12.2 Product Subscription Lifecycle

Optional products must have their own independent subscription lifecycle.

The lifecycle should support:

- Requested.
- Pending Approval.
- Pending Payment.
- Active.
- Renewal Due.
- Cancelled.
- Expired.
- Suspended, where applicable.

An institution's overall subscription status must not automatically determine the status of every individual product.

## 12.3 Subscription Renewal

Recurring institutional subscriptions follow the agreed semester billing arrangement.

Institutions must receive information about upcoming charges and renewal requirements.

Renewal must be based on the applicable subscription agreement.

UniVarse must not introduce unauthorized charges or silently change subscription terms.

## 12.4 Suspension

Suspension must be an authorized administrative action.

The reason, scope, effective date and responsible actor must be recorded.

Where a restriction affects a specific optional product, it should not unnecessarily disable unrelated institutional services.

## 12.5 Termination

Termination must follow the institution's applicable contractual terms.

The system must preserve financial records, invoices, payment history and audit records after termination.

Termination must not automatically result in immediate deletion of institutional data.

Data export, retention and eventual deletion must follow UniVarse's applicable data governance policies.

---

# 13. PRICING AND COMMERCIAL CONFIGURATION

## 13.1 Centralized Pricing Catalogue

UniVarse must maintain a centrally managed pricing catalogue.

The catalogue must support:

- One-time onboarding fees.
- Per-student subscription rates.
- Programme pricing tiers.
- Optional product subscription prices.
- Additional service charges.
- Discounts and approved credits.
- Applicable tax configurations.
- Currency definitions.
- Billing frequencies.

## 13.2 Pricing Versioning

Pricing changes must be versioned.

Each pricing version should record:

- Version identifier.
- Applicable institution or pricing category.
- Pricing components.
- Effective date.
- Expiry date, where applicable.
- Creation timestamp.
- Authorized creator.
- Approval details.
- Change history.

## 13.3 Existing Agreements

An institution's existing agreement must preserve its applicable pricing terms.

A new pricing version must not automatically rewrite an existing invoice or silently alter a contractual price.

Where a pricing change affects an existing institution, the change must follow the agreed commercial amendment and notification process.

Prices are reviewed at most once a year, take effect only from the start of a session, never mid-semester, and are capped by the contract (for example, no more than a stated percentage). A new pricing version needs a second person's approval.

## 13.4 Discounts and Credits

Discounts and credits must require appropriate authorization.

They must be recorded with:

- Amount or percentage.
- Reason.
- Applicable invoice or subscription.
- Effective period.
- Approving authority.
- Audit reference.

Unauthorized manual reductions must not be permitted.

---

# 14. TAXES, REFUNDS AND FINANCIAL ADJUSTMENTS

## 14.1 Taxes

The billing system must support configurable tax calculations.

Applicable tax treatment must comply with the relevant laws and regulatory requirements in the jurisdiction where UniVarse operates and supplies its services.

Tax rates must not be hardcoded into application logic.

The Finance Team must approve the tax configuration before commercial deployment.

The starting assumption, to be confirmed by an accountant: VAT (7.5% at the time of writing) is added to each invoice as its own line, and withholding tax deducted by public institutions is recorded as a credit with its certificate. Whether FIRS e-invoicing applies is to be confirmed.

## 14.2 Credit Notes

Where an invoice requires a financial correction after issuance, the system must support credit notes.

A credit note must reference the original invoice and record the reason for the adjustment.

Credit notes must not overwrite historical invoice data.

## 14.3 Refunds

Refunds must be subject to an authorized review and approval process.

The system must preserve:

- Original payment.
- Refund amount.
- Refund reason.
- Related invoice.
- Provider refund reference.
- Approval details.
- Refund status.
- Audit history.

A refund must not be recorded as a new negative payment without a proper relationship to the original transaction.

## 14.4 Written-Off Balances

The system may support the controlled write-off of outstanding balances.

A write-off must require appropriate authorization and a documented reason.

It must not be used as a mechanism to silently erase financial obligations.

---

# 15. BILLING DASHBOARDS AND USER ACCESS

## 15.1 Institutional Billing Dashboard

Authorized institutional billing administrators should have access to a dedicated billing dashboard.

The dashboard should provide:

- Current semester subscription summary.
- Eligible student count.
- Applicable programme tier.
- Active optional products.
- Current semester invoice.
- Outstanding balance.
- Payment status.
- Approved installment schedule.
- Invoice history.
- Payment history.
- Receipts.
- The count so far, and the list behind it.
- Optional product catalogue.
- Product activation and cancellation requests.
- Billing dispute submission.
- Relevant billing notifications.

## 15.2 Internal UniVarse Finance Dashboard

Authorized UniVarse finance personnel should have access to a centralized billing administration dashboard.

It should provide:

- Institution directory.
- Institutional subscription status.
- Onboarding fees.
- Semester invoices.
- Revenue summaries.
- Outstanding balances.
- Overdue invoices.
- Student count snapshots (numbers only).
- Programme tier information.
- Optional product subscriptions.
- Payment transactions.
- Payment allocations.
- Installment arrangements.
- Reconciliation status.
- Refunds and credit notes.
- Pricing catalogue management.
- Discounts and adjustments.
- Billing audit records.

## 15.3 Role-Based Access Control

Billing permissions must be separate from general academic administration permissions.

Possible permission categories include:

**Institutional roles**
- View billing information.
- View invoices.
- Download invoices.
- View payment history.
- Request optional products.
- Submit billing disputes.
- Manage authorized payment arrangements.

**UniVarse internal roles**
- Finance Viewer.
- Billing Administrator.
- Finance Approver.
- Pricing Administrator.
- Super Administrator.

The exact role definitions and permission boundaries must be formalized in the authorization specifications.

Sensitive financial operations must require the appropriate permission.

---

# 16. TECHNICAL ARCHITECTURE AND DOMAIN BOUNDARIES

## 16.1 Dedicated Billing Domain

UniVarse Billing must be implemented as a dedicated logical domain within the broader UniVarse platform.

It must not become an uncontrolled extension of the academic management domain.

The billing domain owns the commercial relationship between UniVarse and each subscribing institution.

## 16.2 Separation of Domains

The following boundaries must be maintained.

**Academic Domain**

Responsible for:
- Student records.
- Student registration.
- Academic sessions and semesters.
- Faculties and departments.
- Academic programmes.
- Registration eligibility source data.

**Billing Domain**

Responsible for:
- Institutional billing agreements.
- Pricing configuration and versioning.
- Student count snapshots.
- Programme-count snapshots.
- Subscription calculations.
- Invoices and invoice line items.
- Payment plans and installment schedules.
- Credit notes and financial adjustments.
- Billing events and financial reporting.

**Payment Integration Domain**

Responsible for:
- Payment initiation.
- Provider communication.
- Payment attempts.
- Transaction verification.
- Webhook validation.
- Confirmed payment records.
- Payment reconciliation.

**Entitlement Domain**

Responsible for:
- Product access.
- Product activation.
- Subscription entitlement status.
- Product-level restrictions.
- Expiry and renewal enforcement.

These domains may communicate through well-defined internal interfaces and events.

The billing domain must not directly modify academic records to manipulate billable counts.

## 16.3 Subscription, Invoice, Payment and Entitlement Independence

These are separate business objects and must maintain independent state transitions.

An institution may have:

- An active subscription with an unpaid invoice.
- An active optional product with an upcoming renewal.
- A partially paid invoice under an approved installment plan.
- A paid invoice awaiting an entitlement update.
- An overdue optional product subscription while unrelated core services remain active.

The architecture must represent these situations without forcing them into a single global status.

## 16.4 Data Model Considerations

The following entities represent the proposed logical data model.

They are conceptual starting points, not instructions to create tables immediately. Existing UniVarse specifications and database structures must be reviewed before any schema changes are proposed.

**Commercial configuration**
- Billing Accounts.
- Pricing Plans.
- Pricing Plan Versions.
- Programme Tiers.
- Product Catalogue.

**Subscriptions**
- Institution Subscriptions.
- Institution Product Subscriptions.
- Subscription Agreements.
- Subscription Entitlements.

**Usage and metering**
- Academic Billing Periods.
- Student Count Snapshots.
- Programme Count Snapshots.

**Invoicing**
- Invoices.
- Invoice Items.
- Credit Notes.
- Billing Adjustments.

**Payments**
- Payments.
- Payment Attempts.
- Payment Allocations.
- Payment Plans.
- Payment Plan Installments.
- Refund Records.

**Audit and operations**
- Billing Events.
- Reconciliation Records.
- Billing Audit Records.

All institution-owned billing records must be tenant-scoped.

Cross-tenant financial references must be prevented through application authorization and appropriate database constraints.

---

# 17. SECURITY, CONSISTENCY AND FINANCIAL INTEGRITY

The billing system will process sensitive institutional and financial information. Its implementation must follow UniVarse's established security architecture and development standards.

## 17.1 Tenant Isolation

Every institution-owned billing resource must be associated with the correct tenant.

Tenant isolation must be enforced at the appropriate application and database boundaries.

A tenant must never be able to access another institution's:

- Invoices.
- Payment records.
- Subscription agreements.
- Count snapshots.
- Pricing arrangements.
- Product subscriptions.
- Billing disputes.

Cross-tenant administrative access must be explicitly authorized and auditable.

## 17.2 Authorization

All billing operations must enforce role-based permissions.

High-impact operations such as pricing changes, invoice adjustments, refunds, write-offs and manual payment reconciliation must require appropriate authorization.

## 17.3 Audit Logging

The system must generate tamper-evident audit records for financially significant actions.

Audit records should identify:

- Actor.
- Action.
- Target resource.
- Institution.
- Timestamp.
- Relevant before-and-after values, where appropriate.
- Reason or justification.
- Request or correlation identifier.

Existing UniVarse audit infrastructure should be reused where appropriate rather than introducing a duplicate audit system.

## 17.4 Idempotency

Payment webhooks, payment verification operations, invoice generation and other retryable financial processes must be designed to prevent duplicate effects.

Repeated processing of the same valid event must not generate duplicate confirmed payments, allocations or invoices.

## 17.5 Concurrency Protection

The system must account for concurrent requests and background jobs.

Examples include:

- Multiple attempts to close the same semester's count.
- Concurrent invoice generation.
- Duplicate webhook delivery.
- Multiple payment allocation requests.
- Simultaneous subscription renewal processing.

Appropriate database transactions, unique constraints, locking or other concurrency-control mechanisms must be used.

## 17.6 Data Integrity

Financial records must preserve referential integrity.

Invoices must retain their historical line items and pricing.

Payment allocations must never exceed the available verified payment amount.

An invoice must not be marked Paid while a balance remains outstanding, unless an authorized adjustment has settled that balance.

## 17.7 Sensitive Payment Information

UniVarse must not store raw payment card information.

Sensitive payment operations must be delegated to compliant payment providers.

Provider credentials, signing secrets and integration keys must be managed using UniVarse's approved secrets-management architecture.

## 17.8 Reliability and Recovery

The billing domain must support appropriate backups, recovery procedures and operational monitoring.

Financial records must be recoverable and reconcilable following service interruptions or failed processing operations.

---

# 18. BILLING EVENTS AND NOTIFICATIONS

The system should support internal billing events and user-facing notifications.

Relevant events include:

- Institutional subscription approved.
- Onboarding invoice issued.
- Onboarding payment verified.
- Institution activated.
- A semester's official end approaching.
- A semester's count closed.
- Semester invoice issued.
- Payment initiated.
- Payment verified.
- Invoice partially paid.
- Invoice fully paid.
- Installment approaching its due date.
- Installment overdue.
- Invoice overdue.
- Optional product activation requested.
- Optional product activated.
- Optional product renewal approaching.
- Optional product cancelled.
- Subscription approaching renewal.
- Billing dispute submitted.
- Credit note issued.
- Refund processed.

Notifications may be delivered through the UniVarse notification infrastructure and other approved communication channels.

Notifications must not disclose sensitive financial or institutional information to unauthorized recipients.

---

# 19. FINANCIAL REPORTING AND RECONCILIATION

## 19.1 Revenue Reporting

The internal finance dashboard should support reporting on:

- Total invoiced revenue.
- Collected revenue.
- Outstanding receivables.
- Overdue balances.
- Revenue by institution.
- Revenue by semester.
- Student-based revenue.
- Programme-based revenue.
- Optional product revenue.
- Onboarding revenue.
- Discounts and credits.
- Refunds and write-offs.

Reports must distinguish invoiced revenue from actual collected payments.

## 19.2 Payment Reconciliation

Payment reconciliation must compare UniVarse's verified payment records against the relevant payment provider's transaction records.

The process should identify:

- Successful provider transactions missing from UniVarse records.
- Duplicate webhook notifications.
- Unallocated payments.
- Incorrect payment allocations.
- Amount mismatches.
- Failed or reversed transactions.
- Refund inconsistencies.

Reconciliation discrepancies must be recorded and reviewed by authorized finance personnel.

## 19.3 Historical Financial Records

Financial records must remain available for the applicable retention period.

Subscription termination or institution deactivation must not automatically delete historical invoices, payment records or financial audit information.

---

# 20. CONFIGURATION DECISIONS AND FUTURE COMMERCIAL SCHEDULE

The following items must be configurable and formally approved before UniVarse Billing enters production.

Their absence from this policy does not authorize the implementation team to invent commercial values.

| Configuration | Required Decision |
|---|---|
| Onboarding fee | Approved NGN amount |
| Per-student rate | Approved NGN rate per student per semester |
| Programme tier prices | Approved amount for each tier |
| Programme tier thresholds | Final programme-count ranges |
| Optional product prices | Approved price per product per semester |
| Registration standing period | Days a registration must stand to count (starting at 14) |
| Billable student definition | Final eligibility criteria |
| Billable programme criteria | Active and eligible criteria for a programme |
| Core and optional products | Which of UniVarse's products are core, and which optional |
| Usage rates | Admissions per applicant, Live hours, SMS margin |
| Small-institution price | Its eligibility and price |
| Invoice issue | Days after the semester's official end (starting at 14) |
| Payment due date | Standard invoice settlement period |
| Installment limits | Maximum approved installment structure |
| Installment due dates | Approved scheduling rules |
| Grace period | Approved overdue grace duration |
| Tax configuration | Applicable tax treatment |
| Payment provider | Approved integration provider |
| Refund policy | Refund eligibility and approval rules |
| Renewal authorization | Agreed renewal and consent mechanism |
| Commercial amendments | Price-change notification and acceptance rules |

These values should be maintained through controlled commercial configuration and institutional agreements.

They must not be scattered throughout application code.

## 20.1 The Starting Price Sheet

**Approved by the owner on 2026-11-11, all as written:** the core and optional products (Section 6), the per-student rate, optional fees flat per programme tier, and every amount below. All amounts are per semester and before VAT; the price book holds them as data (versioned, two-person approval), so later changes need no release.

**Per-student rate:** **₦5,000** per billable student per semester (₦10,000 a session).

**Programme tiers** (thresholds as in Section 5.3):

| Tier | Programmes | Tier charge per semester | Onboarding fee (one-off) |
|---|---:|---:|---:|
| Starter | 1–10 | ₦250,000 | ₦750,000 |
| Growth | 11–25 | ₦500,000 | ₦1,500,000 |
| Professional | 26–50 | ₦1,000,000 | ₦3,000,000 |
| Enterprise | 51–100 | ₦2,000,000 | ₦5,000,000 |
| Custom | above 100 | quoted | quoted |

**Optional products, per semester by tier:** the starting price book's per-student rate for each product (spec 0030), times a typical size per tier (about 1,000, 3,000, 8,000 and 20,000 students), rounded.

| Product | Starter | Growth | Professional | Enterprise |
|---|---:|---:|---:|---:|
| Teaching & Learning (with Live) | ₦700,000 | ₦2,100,000 | ₦5,600,000 | ₦14,000,000 |
| Assessment (CA CBT) | ₦500,000 | ₦1,500,000 | ₦4,000,000 | ₦10,000,000 |
| Student Affairs | ₦300,000 | ₦900,000 | ₦2,400,000 | ₦6,000,000 |
| Reporting | ₦200,000 | ₦600,000 | ₦1,600,000 | ₦4,000,000 |

**Charged by use:** Admissions **₦400 per applicant** per cycle; Live **10 hours per student per semester included**, then **₦20 per student-hour**; SMS at **cost plus 20%**.

**Free and discounted:** the pilot's first session free (Section 7.5); a **small-institution rate of ₦3,500** per student for a Starter-tier institution with up to 1,000 billable students; training sandboxes never billed.

**Worked semester invoices** (tax at 7.5%, `[VERIFY]`):

| | Small college | Mid polytechnic | Large university |
|---|---:|---:|---:|
| Students; programmes (tier) | 1,200; 8 (Starter) | 6,000; 30 (Professional) | 25,000; 80 (Enterprise) |
| Students × ₦5,000 | 6,000,000 | 30,000,000 | 125,000,000 |
| Tier charge | 250,000 | 1,000,000 | 2,000,000 |
| Applicants × ₦400 | 800: 320,000 | 4,000: 1,600,000 | 30,000: 12,000,000 |
| SMS | 60,000 | 150,000 | 500,000 |
| **Before VAT** | **6,630,000** | **32,750,000** | **139,500,000** |
| VAT | 497,250 | 2,456,250 | 10,462,500 |
| **Semester invoice** | **₦7,127,250** | **₦35,206,250** | **₦149,962,500** |
| Optional products, paid in advance (before VAT) | none | Assessment: 4,000,000 | all four: 34,000,000 |
| **Everything per student per session, before VAT** | **≈ ₦11,050** | **≈ ₦12,250** | **≈ ₦13,880** |

**Affordability, for the owner's judgement:** core alone is ₦10,000 per student per session, against the ICT or portal fees students already pay (about ₦5,000 to ₦25,000 a session, spec 0030's sources). An institution at the low end would need to raise its fee to fund UniVarse from it; the small-institution rate softens this for the smallest.

---

# 21. IMPLEMENTATION ROADMAP — WHEN BILLING IS APPROVED TO BEGIN

This section establishes a possible future implementation sequence.

It is not an instruction to begin implementation immediately.

When UniVarse reaches the appropriate development phase and billing work is formally authorized, implementation should proceed in controlled milestones.

## BILL-01: Commercial Configuration

Establish:
- Pricing catalogue.
- Pricing plan versions.
- Programme pricing tiers.
- Core and optional product definitions.
- Onboarding fee configuration.
- Currency and tax configuration.

## BILL-02: Institutional Subscriptions

Establish:
- Institutional billing accounts.
- Subscription agreements.
- Subscription lifecycle.
- Optional product subscription management.
- Renewal and cancellation workflows.

## BILL-03: Usage Metering and the Count

Establish:
- Academic billing period integration.
- Billable student eligibility.
- The continuous student count.
- Immutable count snapshots at each semester's end.
- Students carried forward.
- Programme-count metering.
- Late-registration handling.

## BILL-04: Invoicing

Establish:
- Invoice generation.
- Invoice line items.
- Pricing snapshots.
- Invoice lifecycle.
- Credit notes.
- Controlled adjustments.

## BILL-05: Payments

Establish:
- Payment-provider abstraction.
- Payment attempts.
- Server-side verification.
- Webhook validation.
- Confirmed payment records.
- Payment allocations.
- Installment plans.
- Reconciliation.
- Refund workflows.

## BILL-06: Entitlements and Dashboards

Establish:
- Product entitlement integration.
- Institutional billing dashboard.
- Internal finance dashboard.
- Billing notifications.
- Subscription renewal visibility.

## BILL-07: Security and Production Readiness

Validate:
- Tenant isolation.
- Authorization boundaries.
- Financial integrity.
- Idempotency.
- Concurrency handling.
- Auditability.
- Reconciliation.
- Backup and recovery.
- Failure handling.
- End-to-end billing workflows.

Each milestone must have appropriate specifications, acceptance criteria, automated tests and security review before it is considered complete.

---

# 22. POLICY GOVERNANCE AND CHANGE MANAGEMENT

This policy is the commercial and architectural baseline for UniVarse Billing.

Any future changes must be reviewed and approved by the appropriate UniVarse product, commercial and technical stakeholders.

The implementation team must not independently change commercial rules simply because an alternative is easier to code.

Changes affecting pricing, student eligibility, count timing, payment arrangements, product renewal or subscription entitlements must be documented and approved before implementation.

Technical improvements may be proposed, but they must preserve the agreed business rules unless a formal policy amendment is approved.

The policy must be version-controlled and maintained alongside the relevant UniVarse specifications and architectural decision records.

---

# 23. IMPLEMENTATION DIRECTIVES

The following instructions are addressed to whoever implements UniVarse Billing.

1. Treat this document as the authoritative billing and subscription policy baseline.
2. Do not reinterpret or casually alter the commercial decisions documented here.
3. Do not invent prices, billing thresholds, payment terms or commercial rules that have not been approved.
4. Preserve the distinction between academic records, billing calculations, verified payments and product entitlements.
5. Preserve UniVarse's existing multi-tenant security architecture.
6. Do not introduce cross-tenant access through billing administration shortcuts.
7. Do not assume that the proposed logical data entities should become database tables without reviewing the existing architecture.
8. Reuse established authentication, authorization, audit, encryption, secrets-management and infrastructure patterns where appropriate.
9. Maintain the existing specification-first development approach.
10. Ensure all future billing changes have appropriate architectural documentation, acceptance criteria, automated tests and security review.
11. Do not compromise existing UniVarse functionality to accommodate billing.
12. Treat financial operations as high-integrity operations requiring explicit authorization, auditability and reliable failure handling.
13. Keep the billing domain independently understandable and maintainable.
14. Do not confuse institutional subscription charges with fees collected by an institution from its own students.
15. Do not introduce an on-premises deployment model through billing or subscription implementation.
16. Do not begin implementation until UniVarse's development roadmap explicitly authorizes the billing work: [18](18-roadmap.md) places it in Phase 1b (S10) and Phase 4.

---

# 24. FINAL POLICY STATEMENT

UniVarse adopts a semester-oriented institutional subscription model combining:

- A one-time institutional onboarding fee, and no deposit.
- A continuous count of students, to the official end of each semester, late registrations included.
- One invoice after each semester, for what it used.
- Per-student recurring subscription charges.
- Tier-based programme subscription charges.
- Flat-fee optional products, paid before they're switched on.
- Services priced on use.
- No minimum recurring subscription fee.
- Full payment as the default settlement method.
- Approved installment arrangements as an alternative.
- Immutable count snapshots and issued invoices.
- Independently verified payments.
- Controlled subscription and product entitlements.

The objective is to create a transparent, scalable and financially sustainable commercial model that can serve institutions of different sizes without compromising the security, reliability and integrity of the UniVarse platform.

**UniVarse must charge institutions accurately, record payments reliably and grant access according to clearly defined subscription entitlements.**

---

# 25. BEFORE IMPLEMENTATION BEGINS

**Do not start building UniVarse Billing yet.**

UniVarse is being developed phase by phase, and billing should be introduced only when the current development roadmap reaches the appropriate stage.

For now, this document should be treated as a finalized policy reference and preserved as part of UniVarse's product and architectural documentation.

Before implementation eventually begins, I recommend the following preparatory steps:

**1. Preserve the policy.**

This document is BP-1. Spec 0030 references it, and each change to it gets a new version.

**2. Do not create billing tables prematurely.**

The proposed entities in this document are conceptual. When the time comes, Claude must first inspect the existing Prisma schema, database relationships, domain boundaries, ADRs and specifications to determine what already exists and what genuinely needs to be introduced.

**3. Finalize the commercial schedule.**

Before production implementation, UniVarse must approve the actual NGN prices, programme tier thresholds, optional product prices, onboarding fee, counting rules and other configurable commercial values.

**4. Review the policy against the future development roadmap.**

When Phase 1 and subsequent phases progress, identify the right point to introduce billing. Billing should integrate cleanly with the established institutional, academic, identity and entitlement foundations rather than forcing changes into unfinished domains.

**5. Prepare a dedicated billing specification package.**

When implementation is authorized, Claude should translate this policy into detailed specifications, architectural decisions, data models, API contracts, state machines, security requirements, test plans and implementation milestones.

**6. Keep the implementation phase-gated.**

Billing should not become an excuse to jump ahead of the current roadmap. Each milestone must be explicitly authorized, implemented, tested and reviewed before the next begins.

**My final recommendation: Save this policy, keep building UniVarse according to the existing roadmap, and return to billing when the platform is architecturally ready for it.**

We are building a business, not just adding a payment button. The billing system must be as carefully engineered as the rest of UniVarse.

**Let's build the platform properly, establish the commercial foundation, and then make UniVarse profitable.**