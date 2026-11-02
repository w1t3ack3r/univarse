# Spec 0029: Practicals: blended laboratory practicals, simulations and virtual labs

**Status:** **Approved by the owner on 2026-11-02, all as written:** Q1 to Q12 and the phasing. Written the same day at the owner's request, after a discussion of online practicals for Phase 4c. Nothing is built from it until its phase starts; each part then gets its own build spec.
**Phase:** spread over 4b, 4c and 7 ([18](../18-roadmap.md)); its own lab player after GA.
**Builds on:**

- [01 §5.1](../01-product-brief.md) (Teaching & Learning) and [01 §5.5](../01-product-brief.md) ("3D virtual labs", deferred, with the hook "embeddable interactive content (sandboxed)"), which this spec replaces with a plan;
- [05 §18](../05-modules-and-features.md): course spaces, materials, assignments and marking, live lecture engagement; [05 §19](../05-modules-and-features.md): the CA contract into results;
- [ADR-020](../19-decision-log.md) (products, entitlements, bulkheads) and [ADR-022](../19-decision-log.md) (UniVarse Live, a Teaching & Learning capability with its own flag);
- [08](../08-security.md) (CSP, sandboxing, third parties) and [16](../16-compliance-ndpa.md) (UniVarse as processor; vendors as sub-processors);
- [spec 0025](0025-phase-1-control-plane.md): the console's library and tool registry ride on E14 and E16.

## Why

Practical-heavy courses (chemistry, physics, biology, engineering) are where online learning is weakest and where Nigerian institutions are most constrained: crowded labs, scarce or broken equipment, consumables that run out, and large classes sharing a few benches. The owner wants lecturers to choose, per practical, whether it runs online, in the lab, or both, with "a good amount of practicals done online".

**The regulator's position supports blended, not replacement.** NUC's *Guidelines for e-Learning in Nigerian Universities* (April 2023, revised) say, at 4.2.9, that there should be provision for "high quality virtual laboratory tools to complement in-person laboratory sessions", so learners can take part remotely "where physical attendance is not possible"; and at 4.6.2 that the assessment of practicals should evaluate the application of skills "to real life situations". COREN's accreditation lists laboratory work as its own criterion and assesses practical class sizes; nothing found says a simulation counts toward it `[VERIFY with COREN]`. So UniVarse makes practicals **better prepared, better organised and partly online**, and never claims an online practical is equivalent to a physical one: that's the institution's and the regulator's call.

## What the research found: content and its licences

What can be hosted by UniVarse (a commercial platform institutions pay for) depends on each source's licence. Checked 2026-11-02:

| Source | What it is | Licence, as found | What UniVarse may do |
| --- | --- | --- | --- |
| **PhET** (Univ. of Colorado Boulder), sims published **before 29 March 2026** | Hundreds of HTML5 physics, chemistry, biology and maths simulations | **CC BY 4.0**, "for non-commercial or commercial purposes", under PhET's agreement for its historical collection. Attribution at the point of use; the PhET logo visible and unaltered; no changes but translation; the PhET name never in our marketing | **Self-host those versions,** frozen, with the attribution |
| **PhET**, sims published **on or after 29 March 2026** | The same library, updated | **CC BY-NC 4.0** (PhET relicensed on 2026-03-30): any use giving "commercial advantage", by a company or a non-profit, needs a commercial licence and partnership | **Not hosted** without a commercial licence (phet-partnerships@colorado.edu: the owner's step). A lecturer may still link to PhET's own site, as any link |
| **ChemCollective** (Carnegie Mellon) | Virtual chemistry bench: titrations, stoichiometry, unknowns | **CC BY-NC-ND**: no commercial use, no derivatives | **Not hosted.** A link only, unless a licence is agreed |
| **CircuitJS** (Falstad, Sharp) | Live circuit simulator | **GPL-2.0-or-later** | **Self-host** as a separate app in its own frame, never linked into our code; its source (with any change) published |
| **JupyterLite** (+ Pyodide) | Python notebooks running entirely in the browser, no server | **BSD-3-Clause**; Pyodide **MPL-2.0** (file-level copyleft only if its files are changed) | **Self-host** freely |
| **LabXchange** (Harvard) | Simulations, protocols, videos | Per item: its terms admit only CC BY and CC BY-NC content | A CC BY item may be hosted with attribution; a CC BY-NC item is a link only |
| **Amrita OLabs** | Physics, chemistry, biology labs | No reuse licence found; the site's terms limit use to the site itself | **A link only** |
| **Wokwi** | Arduino, ESP32, Pi Pico simulator | Commercial; "Wokwi Classroom" priced per student per semester (USD 30, as listed 2026; may be outdated) | Through the institution's own subscription, later (Q9) |
| **Labster** | Polished 3D virtual labs, many subjects | Commercial, per student; LTI | Through the institution's own contract, later (Q9); its data terms to be checked |
| **LabsLand** | **Remote labs:** real equipment controlled online | Commercial, per student per semester; LTI (Moodle, Canvas and others) | Through the institution's own contract, later (Q9) |
| **H5P** | Interactive content (quizzes, interactive video) | Framework MIT; each content type's own licence to check | Not needed now: our own checks (Q5) cover it |

A licence is recorded per item, and nothing enters the library without one that allows it (Q4).

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **Blended by design.** Each practical declares its mode: **online**, **physical** or **blended** (online preparation and analysis around a lab session). UniVarse records each student's practical hours per mode, so an institution can show its accreditors exactly what was online and what was physical. Nothing is ever counted as a physical practical automatically. | NUC 4.2.9 ("complement", "where physical attendance is not possible"), COREN's laboratory criterion, and the owner's choice per practical. |
| Q2 | **A Teaching & Learning capability, not a new product:** `teaching.practicals`, enabled per institution like Live (`teaching.live`, ADR-022), with its own bulkheads: its own job queue, rate-limit bucket and SLO. The simulation library is static files and adds no API load. | Practicals need course spaces, class lists and assignments, which are Teaching & Learning's. A separate product would have to copy or call them for everything (ADR-020's contracts), for no gain. |
| Q3 | **The practical workflow** on a course offering: a **pre-lab** (a safety acknowledgement for the lab, a simulation or video to work through, and an optional short check; Assessment's CA test when the institution has Assessment, through its contract); **lab sessions** (groups, benches, rotations; attendance by the existing check-in); a **post-lab** report as an assignment (rubric, feedback, release into a CA component through the existing contract). A lecturer can require the pre-lab before a student's physical session. | This is where UniVarse adds the most, whatever simulation is used: crowded labs with rotations, safety before entry, and marking that already flows into results. |
| Q4 | **A curated simulation library, self-hosted:** one copy for the platform, each item with its source, version, licence and attribution, served as static files from a **separate origin** in a **sandboxed frame** (no access to the app's cookies, storage or pages), under its own CSP, cacheable for offline use. A CI check refuses an item whose licence isn't on the allowed list. Platform staff curate it in the console; institutions enable it per course. | Free content that works on cheap phones and slow networks, with nothing sent to third parties, and licences enforced by a test rather than remembered. |
| Q5 | **Video-based practicals:** a lecturer records a real experiment once; students take readings at marked moments (a burette, a meter, a timer) and compute results, checked against the lecturer's values with a tolerance. Low-data renditions, as Live's recordings. | Uses the institution's own equipment and methods, costs one recording, and works on any phone. |
| Q6 | **No 3D or VR in the first build.** 2D HTML5 only; heavy 3D content arrives through vendors (Q9) for institutions whose students have the devices. | Low-end Android and slow networks (the product's brief); 3D is where cost and device demands rise fastest. |
| Q7 | **Practicals in Live (Phase 4c):** a lecturer can pin a simulation or a practical step during a live session; students open it beside the call, and Live's polls collect their readings. Shared state between the lecturer's and the students' simulations is not in scope. | The "both" mode the owner described, with what Live already has. Shared state would need per-simulation integration. |
| Q8 | **Self-hosted items send nothing out:** no third-party scripts, analytics or fonts at run time; a student's work in a simulation stays in the browser unless the practical asks for a submission. | NDPA (UniVarse is the processor), and the CSP the app already enforces. |
| Q9 | **Vendor tools through LTI 1.3, later (Phase 7),** each one the institution's own contract (Labster, LabsLand, Wokwi, a newer PhET under partnership): UniVarse as the LTI platform, credentials entered by the institution (write-only), launches carrying a **pseudonymous** student id by default (name or email only per tool, by the institution's choice, with the vendor's DPA recorded), and grades returned into the assignment. The console shows each tool's status per institution (spec 0025 E16). | Real demand decides which vendors; LTI makes each one a configuration, not a build. Pseudonymous launches keep vendors from holding student identities they don't need. |
| Q10 | **UniVarse's own virtual lab player, after GA:** experiments defined as data (apparatus, steps, readings, the mistakes it catches), 2D, for the practicals Nigerian curricula actually run, chosen from what the pilot uses. Its own spec. | The content is the cost, not the code: worth it only once the commonest practicals are known. |
| Q11 | **Accessibility and low data are acceptance criteria:** every hosted item is checked for keyboard use and contrast where it can be, and labelled for its data size; a practical lists what it needs (a laptop, or a phone is enough). | WCAG 2.2 AA is the product's rule; simulations from outside vary, so we say what each one needs. |
| Q12 | **The console:** the library (curate, version, retire, licences), each institution's enabled items and tools, and usage counts per institution (spec 0025 E14), never a student's work. | One place for platform staff to keep the library lawful and current. |

## Phasing

| Part | What | Where | Estimate |
| --- | --- | --- | --- |
| **P1** | The practical workflow (Q1, Q3): modes, pre-lab, safety acknowledgement, sessions with groups, benches and rotations, post-lab reports through assignments, hours per mode | Phase 4b | +1 week |
| **P2** | The simulation library (Q4, Q8, Q11): PhET's historical collection, CircuitJS, JupyterLite; video-based practicals (Q5); the console's library screens (Q12) | Phase 4b | +1 week |
| **P3** | Practicals in Live (Q7) | Phase 4c | +0.5 week |
| **P4** | LTI 1.3 tools (Q9), with the console's tool status | Phase 7 | +1.5 weeks |
| **P5** | Our own virtual lab player (Q10) | after GA, its own spec | to estimate |

So Phase 4b moves from about 7 weeks to about 9, Phase 4c from about 5 to about 5.5, and Phase 7 from about 6 to about 7.5.

## Acceptance criteria (for the build specs)

1. **A blended practical end to end (E2E):** a lecturer sets one up; a student does the pre-lab (simulation and safety acknowledgement), is checked in at a lab session in their rotation, submits the report, and the mark reaches the CA component; the student's hours show one online and one physical part.
2. **The pre-lab gate:** a student without it can't be checked in to a session that requires it, and sees why.
3. **Sandboxing:** a hosted simulation can't read the app's cookies or storage, or navigate the app (a test); its origin is not the app's.
4. **Licences:** the CI check fails on an item with a missing or disallowed licence (a proof, as spec 0026's accessibility gate); every hosted item shows its attribution.
5. **Nothing leaves:** a hosted simulation makes no request outside its own origin (a test).
6. **Isolation (ADR-020):** a practicals load spike leaves the other products' p95 within their SLO.
7. **Cross-tenant and unauthorised cases** for every route, as everywhere else.
8. **LTI (P4):** a launch carries no name or email unless the institution chose it for that tool; a grade returned by a tool lands only in its own assignment.

## The owner's steps

- ~~Approve or change Q1 to Q12 and the phasing.~~ Done: all approved on 2026-11-02.
- **PhET:** decide whether to ask for a commercial partnership (phet-partnerships@colorado.edu) for the sims published after 29 March 2026; without it, the library keeps the historical versions.
- **Regulators `[VERIFY]`:** a written view from COREN (and NUC's quality assurance) on how online practicals count, before an institution relies on them for accreditation.
- **Counsel `[VERIFY]`:** the vendor DPAs for P4 (NDPA), and a review of the PhET historical agreement for a self-hosted, paid platform.

## Affected docs

In this PR: [01 §5.1, §5.5](../01-product-brief.md), [05 §18](../05-modules-and-features.md), [18](../18-roadmap.md) (Phases 4b, 4c, 7 and the estimates). In the build PRs: [02](../02-architecture.md) (the simulation origin), [08](../08-security.md) (the sandbox and its CSP; LTI's threats), [15](../15-integrations.md) (LTI tools), [16](../16-compliance-ndpa.md) (vendors as sub-processors), [19](../19-decision-log.md) (an ADR for the sandboxed library and for UniVarse as an LTI platform).

## Out of scope

Exam-condition practical assessment (CBT for examinations stays deferred, 01 §5.5); 3D and VR in the first build (Q6); shared simulation state in Live (Q7); building simulations of our own before P5.

## Sources

- NUC, [Guidelines for e-Learning in Nigerian Universities](https://www.nuc.edu.ng/wp-content/uploads/2024/06/Guidelines-for-e-Learning-in-Nigerian-Universities-April-2023-Revised-FINAL.pdf) (April 2023, revised), 4.2.9 and 4.6.2, read from the PDF.
- COREN: [OBE accreditation manual for Nigerian universities](https://coren.gov.ng/wp-content/uploads/2020/12/OBE-Accreditation-Manual-for-Nigerian-Universities-Oct.-2020.pdf) and the [EAC manual](https://coren.gov.ng/eac-manual/) (laboratory work as a criterion).
- PhET: [the historical collection's agreement](https://phet.colorado.edu/en/licensing/html) and the [relicensing announcement](https://phetsims.substack.com/p/a-small-change-to-support-a-big-mission) (2026-03-30).
- [ChemCollective's copyright page](https://chemcollective.org/help/copyright); [CircuitJS](https://github.com/sharpie7/circuitjs1) (and [Falstad's](https://www.falstad.com/circuit/about.html)); [JupyterLite](https://github.com/jupyterlite/jupyterlite); [Pyodide](https://pyodide.org/en/314.0.0/_sources/project/about.md); [LabXchange's terms](https://about.labxchange.org/tos); [Amrita OLabs](https://amrita.edu/project/olabs); [Wokwi Classroom](https://wokwi.com/classroom) and [its licence page](https://wokwi.com/license); [LabsLand for universities](https://labsland.com/en/universities/) and [its FAQ](https://help.labsland.com/en/faq/getting-started/); [H5P](https://en.wikipedia.org/wiki/H5P).
- Context: [a review of virtual labs for Nigerian tertiary institutions](https://www.researchgate.net/publication/338997215_A_Review_of_Virtual_Laboratory_and_Justification_for_Adoption_in_Nigeria_Tertiary_Educational_Institutions); NOUN's [practical science in ODL](https://www.academia.edu/126121318/Strengthening_the_Teaching_of_Practical_Science_in_Open_and_Distance_Learning_and_Establishing_a_Sustainable_Culture_of_Applied_Research_at_the_Faculty_of_Sciences_of_the_National_Open_University_of_Nigeria).
