---
name: UniVarse Platform Console
description: UniVarse's own control room — dense, exact work under a deep-green platform bar, on the same tokens as the tenant app.
colors:
  deep: "#485550"
  deep-strong: "#36403C"
  deep-soft: "#E3E9E1"
  lime: "#C0EB6A"
  lime-strong: "#ADDB52"
  lime-wash: "#EEF8D9"
  offwhite: "#F4F6F0"
  white: "#FFFFFF"
  text-muted: "#5D6964"
  on-deep-muted: "#DFE5DC"
  border: "#D7DDD4"
  input-border: "#8A958F"
  danger: "#B42318"
  danger-bg: "#FDECEA"
  warning: "#8A5A00"
  warning-bg: "#FDF3DC"
  success: "#2F6B2F"
  success-bg: "#E8F3E4"
  info: "#275A8A"
  info-bg: "#E6EFF8"
  chart-act: "#B42318"
  chart-watch: "#C98A12"
  chart-note: "#1E6FB8"
typography:
  headline:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.5rem, 1.2rem + 1.2vw, 2rem)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.3
  caption:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    fontFeature: "'tnum'"
rounded:
  sm: "10px"
  md: "14px"
  card: "22px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  tap: "48px"
components:
  platform-bar:
    backgroundColor: "{colors.deep}"
    textColor: "{colors.offwhite}"
    height: "56px"
  env-local:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.deep}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  env-staging:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  env-production:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  button-action:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.deep}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 24px"
    height: "48px"
  button-action-hover:
    backgroundColor: "{colors.lime-strong}"
    textColor: "{colors.deep}"
  button-quiet:
    backgroundColor: "{colors.deep-soft}"
    textColor: "{colors.deep}"
    rounded: "{rounded.md}"
    padding: "0 24px"
    height: "48px"
  card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.card}"
    padding: "24px"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.deep}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "52px"
  table:
    backgroundColor: "{colors.white}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.card}"
  table-head:
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
  tab:
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    padding: "0 16px"
    height: "48px"
  tab-current:
    textColor: "{colors.deep}"
  role-chip:
    backgroundColor: "{colors.deep}"
    textColor: "{colors.offwhite}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-on:
    backgroundColor: "{colors.lime-wash}"
    textColor: "{colors.deep}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-wait:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-off:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-bad:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.white}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-none:
    backgroundColor: "{colors.deep-soft}"
    textColor: "{colors.deep}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  segmented-option:
    textColor: "{colors.deep}"
    typography: "{typography.label}"
    rounded: "11px"
    padding: "0 16px"
    height: "48px"
  dialog:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.card}"
    width: "440px"
  notice-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Design System: UniVarse Platform Console

## Overview

**Creative North Star: "The Control Room"**

The console is UniVarse's own room, not an institution's front desk. A full-width deep-green platform bar (the UniVarse wordmark, "Platform", and the environment chip) sits on every page, so nobody mistakes it for a tenant's workspace. Under it, the work: one column, up to 1200px wide, of sections that each say what they're for in one line and then show the facts, mostly in white tables and lists resting on the sage off-white ground.

It shares every token with the tenant app (`packages/ui/src/tokens.css` and `components.css`): the same Poppins, deep-green ink, lime only for pressable things, 22px cards with one soft offset shadow. What changes is density and voice. Rows are tighter, numbers are tabular, identifiers are monospaced, and the copy is exact ("Revoke Assessment for test-poly"), because staff read many rows and act on few.

Consequential actions are deliberately slower than everything else: they fold away behind a disclosure, ask for a reason and the institution's slug typed out, and step-up opens the console's only modal dialog.

**Key Characteristics:**
- A persistent deep-green platform bar with an environment chip; LOCAL is lime, STAGING amber, PRODUCTION red.
- One content column (max 1200px), sections separated by hairlines, a one-line lead under each heading.
- White tables and row lists on sage; tabular numbers; monospaced identifiers.
- The signed-in header: who you are, a deep role chip, sign out, then the tabs your role can open.
- Institutions shown as data: their colour as a swatch, their logo as a preview, never as the console's theme.
- One modal only: step-up.

## Colors

The tenant app's palette, with the warning pair and three chart fills that the console's operations views need.

### Primary
- **Library Deep Green** (deep): All ink, focus rings, the current tab's underline, the role chip's ground and the platform bar.
- **Press-Me Lime** (lime): The fill of pressable actions under deep-green labels (5.70:1), and the LOCAL environment chip on the bar. On the bar it is also the focus ring.
- **Bar Shadow** (deep-strong): The platform bar's bottom edge, and pressed states on deep.

### Secondary
- **Sage Leaf** (deep-soft): Quiet buttons and the "none" status ("not entitled", "never").
- **Lime Wash** (lime-wash): The "on" status (entitled, active, verified) and text selection: done or on, never pressable.

### Neutral
- **Sage Off-White** (offwhite): The page ground; the bar's text.
- **Card White** (white): Tables, lists, cards, dialogs, inputs.
- **Muted Moss** (text-muted): Leads, metadata, table headings, inactive tabs (5.72:1 on white).
- **Rail Mist** (on-deep-muted): "Platform" beside the wordmark on the bar (6.09:1 on deep).
- **Field Outline** (input-border) and **Hairline** (border): as in the tenant app (3.1:1 for controls; hairlines only between rows and sections).

### Status
- **On** (lime-wash/deep), **Waiting** (warning-bg/warning: due, pending, in progress), **Off** (danger-bg/danger: revoked, suspended, failed), **Bad** (solid danger/white: the chain broken, something needing action now), **None** (deep-soft/deep). Always with a word, and an icon where the row has room.

### Charts
- **Act** (chart-act `#B42318`), **Watch** (chart-watch `#C98A12`), **Note** (chart-note `#1E6FB8`): the security-events chart's three severities. They pass the colour-blind checks together (dataviz validator); legends and labels always carry the meaning.

### Named Rules
**The Lime Is a Button Rule.** Lime fills only pressable things (and the LOCAL chip on the deep bar). Never text, an icon or a focus ring on a light surface (1.37:1).

**The Environment Is Never Quiet Rule.** Anything but LOCAL is coloured to be unmistakable. An unknown environment shows as LOCAL, never PRODUCTION.

**The Institution Is Data Rule.** An institution's colour and logo are shown as a swatch and a preview, exactly as they'll appear for that institution, and never tint the console.

## Typography

**One family:** Poppins (self-hosted via @fontsource, no request to Google). **Mono:** the ui-monospace stack, for slugs, hashes, IDs, recovery codes and the TOTP secret.

**Character:** the tenant app's Poppins, one step smaller and denser. There is no display size: the console never has a hero.

### Hierarchy
- **Headline** (600, clamp(1.5rem → 2rem), -0.015em): the page's h1 and signed-out task titles ("Sign in to the platform").
- **Title** (600, 1.25rem): h2 section titles; the signed-in member's name in the header.
- **Body** (400, 1rem, 1.5): leads (capped at 60–65ch) and all input text (never below 16px).
- **Body small** (400, 0.9375rem): table cells, list metadata, notices; tabular numbers in tables.
- **Label** (500, 0.9375rem): field labels and tabs; the current tab goes 600.
- **Caption** (400, 0.8125rem): table headings (600, muted), chips (600), timestamps, notes.

### Named Rules
**The Tabular Rule.** Counts, dates and times in tables and logs use tabular figures, so columns line up.

**The Sixteen Floor Rule.** Anything you type into is 16px or larger.

## Layout

The 4pt scale (4 to 48) with a 48px touch target, shared with the tenant app.

**Frame:** the platform bar (56px tall, content up to 1200px, 16px gutters), then `main` up to 1200px with 48px above and 40px below. Signed-out screens are one task card, 440px wide, centred under the bar, with their links beneath.

**Signed-in page:** a header row (name, role chip and email on the left; "Find an institution" for roles that can read them; sign out on the right), then the tabs under a hairline, then sections 32px apart, each split from the last by a hairline. A section is a heading, a one-line lead, then the work.

**Breakpoints:** `max-width: 719px` is the phone. Tables restack there: headings hidden visually, each row a two-column grid with the value's label repeated before it, the row's action on the right. Member rows and the header stack to one column. Under 480px the smallest pieces tighten further. Tabs scroll sideways inside their strip; the page itself never scrolls sideways at 360px.

## Elevation & Depth

As the tenant app: flat white on sage, one soft offset deep-tinted shadow.
- **Card rest** (`--uv-shadow-card`): tables, lists, cards, the chain-state line, empty states.
- **Raised** (`--uv-shadow-raised`): the step-up dialog only.

### Named Rules
**The One Interruption Rule.** Only step-up floats. Everything else, consequential forms included, opens in place.

## Shapes

10px for small controls, 14px for buttons, inputs, notices and the segmented control (its options 11px inside it), 22px for tables, lists, cards and the dialog, pills for every chip. Icons are `packages/ui`'s authored set: a 24px grid, 1.75 stroke, round caps, currentColor.

## Components

`packages/ui` draws the shared pieces (buttons, fields, notices, the code field, the expiry bar, icon tiles); the console adds its own `pc-` classes in `apps/console/src/app/globals.css`.

### Platform Bar
Deep green, full width, 1px deep-strong bottom edge. Wordmark (off-white and lime SVG), a 1px divider, "Platform" in rail mist at 15px 500, and the environment chip (caption 600, 0.08em tracking) on the right. The wordmark links home, with a lime focus ring.

### Header and Tabs
The member's name (title), a deep role chip (caption 600, off-white on deep, 7.44:1) and email (muted). Tabs are 48px tall, muted at 500; hover goes to deep; the current tab is deep, 600, with a 3px deep underline over the hairline. Only the tabs the member's role can open are shown.

### Tables and Row Lists
White, 22px corners, card shadow. Headings are caption 600 muted; cells 16px padding with hairline rows; the action column is right-aligned and as narrow as it can be. Row lists (home, staff) have 80px rows with a bold title and muted meta; a whole row may be a link, underlining its title on hover.

### Status and Role Chips
Pills, caption 600, 3px 10px. Status uses the five tones above, always with a word. The role chip is deep with off-white text.

### Segmented Control
Two or three choices side by side (a period, a decision): 48px options inside a 14px track, real radio inputs underneath.

### Consequential Actions
Folded behind a disclosure until asked for. The form names the institution and the consequence, asks for a reason (5 to 500 characters), and, for anything that takes something away, the institution's slug typed out. The confirming button says exactly what it does. Step-up, when needed, opens the dialog: native `<dialog>`, max 440px, 22px corners, raised shadow, backdrop deep at 55%.

### The Audit Log
One entry a row, what happened first (because that is what people scan for), then who and when; each row expands for its detail. Above it, one quiet line says whether the chain verifies, with a "Bad" chip when it doesn't.

### Charts
Plain bars in the three chart fills, a labelled axis and maximum, a legend, a readout of the bar under the pointer, and a table below it holding every value. No dual axes, no colour without a label.

### Branding Preview
An institution's colour as a swatch beside its hex value, and a preview showing the colour, its computed text colour and the logo together, exactly as they'll sit on that institution's sign-in page.

### Step Track (spec 0034)
Provisioning's eight steps on one vertical rail: a 24px mark per step, the rail deep where the steps before are done. Done is a deep mark with a white check, running is a turning deep-and-sage ring (still under reduced motion, the word "Running" beside it), stopped is a danger mark with "Stopped here", pending an open ring with a muted label. Each step has its label (600) and a one-line plain explanation. The same track previews the steps on the New institution form and shows them live (refreshed every 2 seconds) on the institution's page; once finished it folds behind "Show the steps".

### Approvals (spec 0037)
A two-person request is read top to bottom as a decision: the action as the page title ("Make Ada Obi an owner") with its status chip; the requester's reason as a quotation on a sage panel (`deep-soft`, 14px corners, the text kept to 65ch); then **the receipt**, a white card titled "Exactly what will run": the consequence in one line, then label–value rows divided by hairlines (labels caption 600 muted, values monospaced as stored, the named person's name under their id), ending with the payload's fingerprint, which wraps anywhere. The decision sits in its own white card below: one sentence saying who you are in this ("You're the second person"), then the lime action naming exactly what it does ("Approve: make Ada Obi an owner", allowed to wrap on a phone) beside a quiet red Reject. A decided request replaces the card with a notice or a muted line saying what happened and that nothing else changed.

### Inbox and Counts (spec 0037)
The inbox is a row list (the Overview's `pc-list`): an icon tile for where the item comes from, its title and one line of what to do, a status chip saying how urgent ("Decide", "Stopped", "Act"), and an arrow; the whole row links to where it's dealt with. Empty, it's one quiet card: a check in an icon tile and "Nothing needs you right now." Counts (`pc-count`) are small deep pills with off-white tabular numbers, on the Inbox tab and beside a group's heading; the number carries the meaning, never the colour.

### Composing Forms (New institution)
A long form is split into titled white groups (`pc-group`: 22px cards, the legend set as a title inside), with two-column field pairs that stack under 15rem. Beside it on wide screens (≥1000px), a sage aside (`deep-soft`) says what will happen, sticky while the form scrolls. Choices are offwhite rows that turn lime-wash when ticked; a locked choice (Core) stays ticked and disabled. One lime action at the end, with a note that step-up will follow.

### Checklists (Going live)
A white row list, one row per computed item: an open ring or a deep check, the item, what it needs (with a link to where it's fixed, for those who may fix it), and a "Done" or "To do" chip aligned at the top right. The action under it is disabled with its reason beside it until every item passes.

### Loading and Empty
While the platform API answers, a skeleton keeps the page's shape with no content. An empty list is a white card with one muted, centred sentence saying what will appear there.

## Do's and Don'ts

### Do:
- **Do** keep the platform bar and its environment chip on every page.
- **Do** name the institution, the action and its consequence on every consequential form and button.
- **Do** ask for a reason and the typed slug for anything that takes something away; show the two-person status where one is required.
- **Do** use tabular numbers in tables and logs, and monospace for slugs, hashes and IDs.
- **Do** show only the tabs and actions the member's role allows; a refusal is 404, not a disabled button.
- **Do** restack tables at 719px and keep the page free of sideways scroll at 360px.

### Don't:
- **Don't** theme the console with an institution's colour or logo; show them only as data.
- **Don't** use lime as text, an icon or a focus ring on a light surface.
- **Don't** add a second modal: only step-up interrupts.
- **Don't** add navigation, sections or numbers for features that don't exist yet, and never mock data.
- **Don't** show tenant personal data, or offer "log in as user".
- **Don't** let STAGING or PRODUCTION look like LOCAL.
