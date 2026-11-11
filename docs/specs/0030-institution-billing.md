# Spec 0030: Institution billing: subscriptions, the student count and semester invoices

**Status:** **Approved by the owner on 2026-11-06, all as written:** B1 to B16 and the phasing. Written 2026-11-05 at the owner's request, from the billing model the owner chose that day: **billed per semester, in arrears, for the students and products actually used**, with a setup fee and, for a new institution, a deposit. The prices below are **starting assumptions**, held as settings and changed after talking to the first institutions; nothing in code depends on them. **Amended on 2026-11-10** by the owner's billing policy, [BP-1](../billing-model.md): see [the amendment](#amendment-2026-11-10-the-billing-policy-bp-1). Where they differ, the amendment wins; BP-1 is the reference for what this spec doesn't cover.
**Phase:** 1b (S10) and 4 ([18](../18-roadmap.md)).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md) A13 ("plans and subscriptions now; invoices and usage later", prices `bigint` kobo), S10, E4 (the two-person queue: "plan-price changes need a second person"), E12 (the delivery log), E14 (counts written by a tenant-side job), E20 (contracts, renewals, key contacts);
- [ADR-020](../19-decision-log.md) and [spec 0003](0003-product-entitlements.md): products are entitled per institution; a subscription drives the entitlements;
- [01 §5.5](../01-product-brief.md): **UniVarse never holds institutions' money**; students' fees settle directly to the institution's own gateway account;
- invariants 3 (money in `bigint` kobo), 4 (business rules as pure functions in `packages/domain`), 5 (immutable financial records: corrections are reversals), 6 (audit and outbox in one transaction).

## Why

UniVarse needs a way to charge institutions that is fair, easy to explain and safe for a small company carrying a year of hosting and support costs. The owner rejected "pay once at the end of the session" because UniVarse would wait about a year, and then for payment, before earning anything from an institution. Billing per semester, for what was used, halves the wait and keeps "pay for what you used".

**What the market showed (2026-11-02):** students already pay ICT or portal fees of roughly ₦5,000 to ₦25,000 a session (UNIOSUN ₦20,000–₦25,000; FUTES ₦5,000; NOUN ₦10,000 a semester); school software sells at about ₦300 to ₦1,000 per student per term; university systems publish no prices. So the whole suite should cost an institution less per student than the ICT fee it already collects ([sources](#sources)).

## The model, in one paragraph

An institution signs a contract, chooses a bundle or products, and pays a **one-off setup fee** (and, if it's new to UniVarse, a **deposit**). During each semester UniVarse **counts its active students continuously**, late registrations included, and the institution sees the count and the bill building up. **At the end of each semester** UniVarse issues **one invoice** for the active students and the products used, plus anything charged by use (applicants, Live hours, SMS). The institution pays UniVarse by **bank transfer or Remita**, from its own money (often the ICT fee it collects). If it doesn't pay, a **grace period**, then **new admissions and registrations pause**; students never lose their results, transcripts or records.

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| B1 | **Billing per semester, in arrears.** One invoice per semester, issued a set number of days after the semester ends (default 14), for what that semester used. Rates are quoted per session and charged half per semester. | The owner's choice: a fair bill for real usage, and about 5 to 6 months of exposure instead of a year. |
| B2 | **The billable student:** a student with at least one course registration in that semester that stood for at least **14 days** (a setting), late registrations included. A registration cancelled within the 14 days doesn't count. Graduated, withdrawn and inactive students without a registration don't count. | Counts real use; doesn't bill an institution for a mistaken registration fixed in the first fortnight. |
| B3 | **The count is continuous and private.** A tenant-side job writes, each day, only the **numbers** into the platform database (active students per semester, per product in use), as spec 0025 E14 does. The console never sees who the students are. The institution's own authorised staff can open the **list behind the count** in their workspace (they're the controller of that data), to check it. | The console can't read tenant personal data (Phase 1 exit criterion 6), and a disputed count must be checkable by the institution. |
| B4 | **The running bill:** the institution's IT Admin and a "billing viewer" role see, in their workspace, the semester's count so far and the bill it would produce today, with the price book in force. | The owner's "no surprises": the invoice is never the first time an institution sees a number. |
| B5 | **The price book is data, versioned, and approved by two people.** Products' rates per student, bundles, volume bands, the minimum fee, usage rates, setup fees and the deposit rule live in a versioned price book in the platform database. A new version takes effect only from a **session's start**, never mid-semester, and goes through the two-person queue (spec 0025 E4). Each invoice records the version it used. | Prices will change after the first conversations; changing them must not need a release, and must never change a semester already under way. |
| B6 | **How an invoice is computed** (a pure function in `packages/domain`, in kobo, integers only): for each product or bundle, **students × rate**; volume bands applied **marginally** (the first 5,000 students at the full rate, the next 15,000 at the band's rate, and so on), so there's no cliff at a band's edge; then the **usage lines**; then, if the total is under the **minimum fee** for the semester, a "minimum fee" line making up the difference; then **VAT** (B13). Rounding: each line to the kobo, half up, once. | Explainable line by line, the same on every machine, and no floating point (invariant 3). |
| B7 | **Usage priced on use:** **Admissions** per applicant in a cycle (applicants aren't students yet); **Live** with hours included per student and extra hours at a rate; **SMS** at cost plus a margin. Each comes from a count the product writes, like B3. | Products with their own running costs are priced on what drives those costs. |
| B8 | **The setup fee and the deposit,** invoiced at signing: the setup fee scaled by the programmes and the data to import (onboarding work); the deposit, for a **new** institution only, about one semester's minimum fee, applied to its last invoice or refunded when it leaves, and waived after two semesters paid on time (a setting). | Onboarding is real work, and the deposit covers the first semester's risk without asking established customers for it. |
| B9 | **Invoices are immutable.** A wrong invoice is never edited: a **credit note** reverses it, in whole or in part, and a new invoice replaces it. Late corrections to a count (B2's list changed after issue) go on the **next** invoice as an adjustment line. Every invoice, credit note and payment is audited in the same transaction, with an outbox event (mail, the delivery log). | Invariants 5 and 6: money records are append-only, and every change is explained. |
| B10 | **Payments to UniVarse** are recorded against an invoice: by bank transfer (recorded by platform finance staff, with step-up, and the bank's reference), or later through UniVarse's own Remita or gateway account (verified server-side or by a signed webhook, idempotent, invariant 7). A receipt is issued. Part-payments are allowed; the balance stays due. | Public institutions pay by transfer and Remita; recording must be as strict as the tenant side's payments. |
| B11 | **When an invoice isn't paid:** reminders at the due date and at intervals (logged, E12); after a **grace period** (default 30 days past due), a **billing hold**: no new admission cycle can open and no new course registration is accepted. Everything else keeps working: sign-in, results, transcripts, records, existing registrations, students paying the institution. The hold lifts automatically when the invoice is paid. A billing hold is **not** a suspension (S6, which blocks sign-in): suspension and offboarding stay separate, deliberate decisions. | Pressure on the institution, never on its students: locking students out of their results over the institution's debt would harm the wrong people and UniVarse's name. |
| B12 | **The contract** (spec 0025 E20) holds the billing contacts, the payment terms (default 30 days), the bundle, the review cap and the deposit; invoices go to the billing contacts by email. | One place for what was agreed. |
| B13 | **Tax is a setting, and is checked:** VAT (7.5% at the time of writing) added to each invoice as its own line; withholding tax deducted by public institutions recorded as a credit with its certificate. `[VERIFY with an accountant]`: the rates, whether FIRS e-invoicing applies, and how withholding is evidenced. | Public institutions deduct and remit tax; the books must still balance. |
| B14 | **Price reviews:** at most once a year, effective from a session's start, capped by the contract (for example, no more than a stated percentage). Paying a whole session upfront earns a discount (a setting). | Most of UniVarse's costs are in dollars and its income in naira; institutions need predictability. |
| B15 | **Free and discounted:** the **pilot** institution's first session is free (invoiced at ₦0 with a 100% discount line, so the record exists); the **training sandbox** (spec 0025 E17) is never billed; a **small-institution** Essentials price lives in the price book. Core is always included. | Win the first institutions without giving away the product most expensive to run (Academics) for good. |
| B16 | **Not in scope now:** collecting UniVarse's fee as a split of students' online payments. It would keep UniVarse from holding institutions' money (it would take only its own fee), but it needs legal and finance review first. | The owner's idea for later; recorded so it isn't lost. |

## The starting price book (assumptions, per active student; superseded on 2026-11-11 by [BP-1 §20.1](../billing-model.md))

Rates are per **session**; each semester bills half.

| Product | Per active student, per session |
| --- | --- |
| Core | included |
| Academics | ₦1,500 |
| Bursary | ₦500 |
| Teaching & Learning (with practicals, spec 0029) | ₦700 |
| Assessment (CA CBT) | ₦500 |
| Student Affairs | ₦300 |
| Helpdesk & Comms (SMS by use) | ₦200 |
| Reporting | ₦200 |

- **Bundles:** Essentials (Core, Academics, Bursary); Campus (Essentials, Admissions, Student Affairs, Helpdesk & Comms, Reporting); Complete (everything), each about 15–20% below the sum of its parts.
- **Volume bands (marginal):** up to 5,000 students at the full rate; 5,001 to 20,000 at 15% off; above 20,000 at 30% off.
- **Usage:** Admissions ₦300–₦500 per applicant per cycle; Live hours included, then per hour; SMS at cost plus a margin.
- **Minimum fee:** about ₦1,000,000 per session (₦500,000 per semester).
- **Setup fee:** about ₦500,000 (a small college) to ₦3,000,000 (a large university).

**A worked example** (Campus bundle, 10,000 students, first semester, before tax): Campus's own rate × the first 5,000 students, plus the same rate less 15% × the next 5,000, halved for the semester, plus the applicants of any admission cycle that semester, plus SMS; the minimum fee doesn't apply at this size. Every line appears on the invoice.

## Phasing

| Part | What | Where |
| --- | --- | --- |
| **P1** | The price book (B5) and its two-person approval; plans and subscriptions driving entitlements (A13); contracts and billing contacts (B12, E20); the setup-fee and deposit invoices (B8); invoices, credit notes, payments and receipts (B9, B10); tax lines (B13); the console's billing screens | S10, Phase 1b |
| **P2** | The continuous count (B2, B3) and the running bill (B4); usage counts (B7); end-of-semester invoices (B1, B6); reminders and the billing hold (B11); the institution's list behind the count | Phase 4 (the first phase with course registration to count) |

S10 grows by about a week; Phase 4 by about a week and a half (Phase 4 moves from about 6 weeks to about 7.5).

## Amendment, 2026-11-10: the billing policy (BP-1)

The owner wrote a fuller billing policy, [BP-1](../billing-model.md), and decided on 2026-11-10 how it and this spec fit together. **BP-1 amends this spec**, and stays the reference for everything this spec doesn't cover: installment plans, refunds, write-offs, reconciliation, the dashboards and the domain boundaries.

| # | Before | Now |
| --- | --- | --- |
| B1 | Per semester, in arrears | **Unchanged.** One invoice after each semester's official end. |
| B2 | A registration standing 14 days; late registrations count | **Unchanged**, and counted **to the semester's official end**. A student whose 14 days finish after it is carried onto the next invoice, once (BP-1 §4.5). |
| B3, B4 | The continuous, private count; the running bill | **Unchanged.** Snapshots hold numbers and a fingerprint of the list, never who (BP-1 §4.4). |
| B5 | The price book: per-product rates, bundles, volume bands, the minimum fee, setup fees, the deposit rule | **The price book's contents change** (below). Versioned, two-person approval and session-start effect are unchanged. |
| B6 | Per product: students × rate, marginal volume bands, the minimum-fee top-up, then VAT | **Replaced:** `T = (S × Rs) + Pt + ΣUj + C − D`, then tax (BP-1 §9.3). **One per-student rate** (`Rs`), a **programme tier charge** (`Pt`), usage (`Uj`). Optional products are billed on their own invoices, in advance (R1). No bundles, no volume bands, **no minimum fee**. Each line in kobo, rounded half up, as before. |
| B7 | Usage priced on use | **Unchanged** (BP-1 §7.4). |
| B8 | The setup fee, and a deposit for a new institution | **No deposit.** The setup fee stays, paid before activation. The semester's charges are invoiced after it; optional products are paid in advance (R1). |
| B9, B10 | Immutable invoices; payments recorded and verified | **Unchanged.** **Full payment is the default**, and an institution may ask for an **installment plan**, approved by UniVarse finance (BP-1 §10.3). |
| B11 | The billing hold: no new admission cycle or registration after 30 days past due | **Replaced by BP-1 §11:** reminders and escalation; any service restriction is set by the contract, product by product, and never touches academic records. No automatic hold by default. |
| B12, B13, B14 | The contract; VAT and withholding `[VERIFY]`; the yearly, capped price review | **Unchanged** (BP-1 §13.3, §14.1). |
| B15 | The free pilot, the sandbox, a small-institution price | **Unchanged** (BP-1 §7.5). |
| B16 | Collecting UniVarse's fee from students' payments, later | **Unchanged.** |
| New | | **The programme tier** (BP-1 §5): a billable programme is a formally approved qualification (B.Sc. Computer Science, HND Accountancy), never a faculty, department, level, course or cohort, counted at the semester's official end. |

**Read from the owner's answers, confirmed by the owner on 2026-11-10** (R1 as the owner corrected it):

| # | Reading | Why |
| --- | --- | --- |
| R1 | **Optional products are paid in advance,** immediately before they're switched on: a product invoice for the semester, verified, then the entitlement. Each renewal is invoiced before its semester, and a cancelled product runs to the end of the semester paid for (BP-1 §6.4 to §6.7). | The owner's correction: "immediately before approved for use, and not after the semester". |
| R2 | **The programme count is taken at the semester's official end,** with the student count. | One measurement point, the same as the students'. |
| R3 | **VAT, withholding and the yearly review cap stay** as B13 and B14 had them. | The answers didn't change them. |
| R4 | **The volume bands go,** with the per-product rates. | One per-student rate leaves nothing to band. They can return as tiers of `Rs` if the owner wants them. |

**Decided on 2026-11-11:** core is Core, Academics, Bursary, Admissions and Helpdesk & Comms; optional is Teaching & Learning (with Live), Assessment, Student Affairs and Reporting; the per-student rate is **₦5,000 a semester**; optional fees are **flat per programme tier**. The starting price sheet is [BP-1 §20.1](../billing-model.md), where the tier charges, optional fees, usage rates, onboarding fees and the small-institution rate are a draft for the owner's approval. The starting price book above is kept as the reasoning it was, not as prices.

## Acceptance criteria (for the build specs)

1. **The computation:** golden fixtures for the amended B6 (the programme tier at and across a threshold, optional products, usage lines, students carried forward, rounding, VAT), as a pure function; the same input gives the same kobo on every run.
2. **The count:** a registration cancelled within 14 days doesn't count; a late one does; a student with two registrations counts once; the console's data holds numbers only (a test), and the institution's list matches the number.
3. **Immutability:** an invoice can't be changed (the database refuses); a correction is a credit note plus a new invoice, both audited.
4. **The price book:** a version can't take effect mid-semester; a change without a second approver is refused; each invoice names its version.
5. **Payments:** a gateway payment credits only after server-side verification or a signed webhook, once (a replay does nothing); a manual payment needs step-up and is audited.
6. **Restrictions (amended B11):** a restriction applies only as the contract sets it, product by product; sign-in, results, transcripts and existing records always work (an E2E); paying lifts it.
7. **Cross-tenant and unauthorised cases** on every route, as everywhere.

## The owner's steps

- ~~Approve or change B1 to B16 and the phasing.~~ Done: all approved on 2026-11-06.
- **Prices:** test the starting price book with the first institutions; change it through the console before the first invoice.
- **An accountant `[VERIFY]`:** VAT, withholding tax and e-invoicing for UniVarse's services to public and private institutions.
- **A lawyer `[VERIFY]`:** the contract (payment terms, the billing hold, the review cap, the deposit), and, later, B16.

## Affected docs

In this PR: [03 §1](../03-domain-model.md) (the platform billing entities), [05 §1](../05-modules-and-features.md) (the plans and invoices row), [18](../18-roadmap.md) (S10, Phase 4), [spec 0025](0025-phase-1-control-plane.md) (A13 refined). In the build PRs: [04](../04-business-rules.md) (the computation as a business rule), [06](../06-api-guidelines.md) (the billing routes), [07](../07-data-and-database.md) (immutability and grants), [08](../08-security.md) (who sees billing; step-up), [16](../16-compliance-ndpa.md) (the count's privacy), [19](../19-decision-log.md) (an ADR for billing in arrears with the billing hold).

## Out of scope

Collecting UniVarse's fee from students' payments (B16); currencies other than the naira; credit-card billing; automated dunning beyond reminders and the hold; billing a federation of institutions (ADR-021).

## Sources

- [UNIOSUN schedule of fees](https://uniosun.edu.ng/uniosun-schedule-of-fees/); [University of Ilesa school fees](https://www.unilesa.edu.ng/schoofees-main); [FUTES fees schedule](https://allschool.ng/futech-school-fees-schedule/); [NOUN fees breakdown](https://campusninja.com.ng/open-university-school-fees/); [Paul University's portal fee](https://monoed.africa/blog/cheapest-private-universities-in-nigeria).
- School software pricing: [Nairametrics](https://nairametrics.com/2026/08/19/top-5-school-management-systems-in-nigeria-what-schools-get-for-their-money/), [Headteacher.ng](https://www.headteacher.ng/best-school-management-software-nigeria-2026/), [Nigerian Queries](https://nigerianqueries.com/best-school-management-software-systems-in-nigeria/). Vendor and blog figures, not quotes.
