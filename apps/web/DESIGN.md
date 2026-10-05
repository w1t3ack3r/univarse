---
name: UniVarse Web
description: The institution's own front door — sign-in journeys and the workspace shell, in a warm consumer-app world.
colors:
  deep: "#485550"
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
  success: "#2F6B2F"
  success-bg: "#E8F3E4"
  info: "#275A8A"
  info-bg: "#E6EFF8"
typography:
  display:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(2rem, 1.35rem + 2.9vw, 3.5rem)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.03em"
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
    lineHeight: 1.2
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
  code-digit:
    fontFamily: "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "'tnum'"
  mono:
    fontFamily: "ui-monospace, 'Cascadia Mono', 'Roboto Mono', 'Droid Sans Mono', Menlo, Consolas, monospace"
    fontSize: "0.9375rem"
    fontWeight: 600
    letterSpacing: "0.02em"
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
  button-action-disabled:
    backgroundColor: "{colors.offwhite}"
    textColor: "{colors.input-border}"
  button-quiet:
    backgroundColor: "{colors.deep-soft}"
    textColor: "{colors.deep}"
    rounded: "{rounded.md}"
    padding: "0 24px"
    height: "48px"
  button-plain:
    textColor: "{colors.deep}"
    typography: "{typography.label}"
    padding: "0 8px"
    height: "44px"
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
  code-cell:
    backgroundColor: "{colors.offwhite}"
    textColor: "{colors.deep}"
    typography: "{typography.code-digit}"
    rounded: "{rounded.md}"
  code-cell-filled:
    backgroundColor: "{colors.white}"
  icon-tile:
    backgroundColor: "{colors.lime-wash}"
    textColor: "{colors.deep}"
    size: "44px"
  pill:
    backgroundColor: "{colors.white}"
    textColor: "{colors.deep}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  status-on:
    backgroundColor: "{colors.lime-wash}"
    textColor: "{colors.deep}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  status-off:
    backgroundColor: "{colors.deep-soft}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  notice-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "16px"
  notice-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info}"
    rounded: "{rounded.md}"
    padding: "16px"
  notice-success:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
    padding: "16px"
  navlink-active:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.deep}"
    height: "48px"
  rail:
    backgroundColor: "{colors.deep}"
    textColor: "{colors.offwhite}"
    width: "248px"
  expiry-track:
    backgroundColor: "{colors.deep-soft}"
    rounded: "{rounded.pill}"
    height: "6px"
  expiry-fill:
    backgroundColor: "{colors.deep}"
  switch-on:
    backgroundColor: "{colors.lime}"
    rounded: "{rounded.pill}"
    width: "52px"
    height: "30px"
  switch-off:
    backgroundColor: "{colors.deep-soft}"
    rounded: "{rounded.pill}"
    width: "52px"
    height: "30px"
---

# Design System: UniVarse Web

## Overview

**Creative North Star: "The Friendly Front Desk"**

The tenant web app is the institution's own front desk, staffed by an app you already trust. The institution's name is the biggest thing on the screen; UniVarse sits in a small white pill or a rail footer as the trust mark. Every screen holds one task on one borderless white card resting on a sage off-white ground, written in plain words with exactly one lime thing to press.

The world is a warm consumer app, not a bank and not a SaaS template: Poppins at real, generous sizes in deep-green ink, soft 22px card corners, round pale-green icon tiles, 48px touch targets, and a floating thumb bar on phones that becomes a deep-green rail on desktop. Security moments (codes, two-step setup, step-up) stay calm: fixed one-digit code cells, a step strip that shows where you are in a flow, and a bar whose length is the exact time left.

Density is low and phone-first. Depth is a single soft, offset shadow under cards; nothing glows, nothing has a hard border except fields that need a 3:1 outline.

**Key Characteristics:**
- Sage off-white ground, borderless white cards, soft offset shadow.
- Deep green (#485550) for all ink, focus and progress; lime only as the fill of pressable things.
- Institution name as hero (display size); UniVarse as a small trust mark.
- One task per card; flows keep one fixed card frame with a step strip.
- Signature: six fixed code cells plus a draining expiry bar.
- Phone: floating thumb bar. Desktop (≥900px): 248px deep-green rail.

## Colors

A two-ink brand palette (deep green and lime) on a sage-and-white ground, with quiet tinted status pairs that always travel with words and an icon.

### Primary
- **Library Deep Green** (deep): All text, headings, icons, focus rings, step-strip progress and the expiry bar on light surfaces (7.80:1 on white, 7.17:1 on off-white). Also the ground of the desktop rail and the name-plate initials tile.
- **Press-Me Lime** (lime): The action colour. Fills the primary button, the current nav item (thumb bar and rail), the "on" switch track and text selection — always under deep-green labels (5.70:1). On the deep rail it may become ink (the initials in the name plate) and the focus ring.
- **Pressed Lime** (lime-strong): Hover fill for the lime action (deep text 4.84:1).

### Secondary
- **Sage Leaf** (deep-soft): Quiet fills on light ground — the quiet button, step-strip and expiry tracks, "off" switch track, "off" status chip, field-toggle hover (deep text 6.32:1).
- **Lime Wash** (lime-wash): Pale green for things that are *done* or *on*, never pressable: round icon tiles, the success/done mark, the welcome seal, the "on" status chip (deep text 7.09:1).

### Neutral
- **Sage Off-White** (offwhite): The page ground everywhere; also empty code cells, recovery-code tray, checkbox rows, the disabled action fill.
- **Card White** (white): Cards, dialog, inputs, filled code cells, trust pill, thumb bar.
- **Muted Moss** (text-muted): Secondary text — ledes, hints, metadata, inactive nav, footers (5.72:1 on white, 5.26:1 on off-white).
- **Rail Mist** (on-deep-muted): Muted text on the deep rail (6.09:1 on deep).
- **Field Outline** (input-border): Resting outline of inputs, code cells and switch track (3.1:1 on white, meets WCAG 1.4.11). Darkens to text-muted on hover and to deep on focus.
- **Hairline** (border): Decorative dividers only — list rows and table rows (1.38:1, never a control boundary).

### Status
- **Danger** (danger on danger-bg): Errors, invalid fields and code cells (6.57:1 on white). Always with an alert icon and, on notices, a support reference.
- **Success** (success on success-bg) and **Info** (info on info-bg): Notice tones, always with an icon.

### Named Rules
**The Lime Is a Button Rule.** Lime fills only things you can press, and its label is always deep green. Lime is never text, an icon or a focus ring on a light surface (1.37:1 on white). A disabled action loses lime entirely and drops to off-white with a hairline inset — lime always means "you can press this now".

**The Wash Is Not Lime Rule.** States that are finished or on (done marks, icon tiles, "On" chips) use lime-wash, not lime, so they never read as pressable.

**The Never Colour Alone Rule.** Every status carries words and an icon; colour is the third signal, not the first.

## Typography

**Display Font:** Poppins (self-hosted via @fontsource, with system-ui fallback)
**Body Font:** Poppins
**Label/Mono Font:** ui-monospace stack, only for TOTP secrets and recovery codes

**Character:** One rounded geometric family does everything: 600 for anything that names or commands, 500 for labels and links, 400 for reading. Tight negative tracking at display size gives the institution name a confident, friendly heft.

### Hierarchy
- **Display** (600, clamp(2rem → 3.5rem), 1.04, -0.03em): The institution name on sign-in screens (drops to clamp(1.75rem → 2.5rem) under 960px) and workspace page titles ("Good afternoon, Ada", "Products"). Balanced wrap.
- **Headline** (600, clamp(1.5rem → 2rem), 1.2, -0.015em): The task heading inside a card ("Welcome back", "Check your email") — the h1 screen readers land on. Also the welcome name on activation done.
- **Title** (600, 1.25rem, 1.2): Section titles in the workspace; institution name at the top of the desktop rail.
- **Body** (400, 1rem, 1.5): Default reading text and all input text (16px minimum: no zoom on focus). Ledes cap at ~30–38rem.
- **Body small** (400, 0.9375rem, 1.55): Card sub-lines, list metadata, notices, table cells.
- **Label** (500, 0.9375rem, 1.3): Field labels; button text uses 600 at 1rem.
- **Caption** (400, 0.8125rem, 1.45): Hints, field errors, step-strip labels, expiry label, footers, status chips (600).
- **Code digit** (600, 1.5rem, tabular): One digit per code cell.

### Named Rules
**The Sixteen Floor Rule.** Anything you type into is 16px (1rem) or larger.

**The Name Is the Hero Rule.** On a tenant address the institution's name is the largest type on the page; UniVarse never out-scales it.

## Layout

A 4pt spacing scale (4, 8, 12, 16, 20, 24, 32, 40, 48) with a 48px touch target. Page gutters are fluid: clamp(16px, 4vw, 40px).

**Sign-in shell:** a three-row grid (top trust pill, body, quiet footer) at full dynamic viewport height. Under 960px it is one column: institution name, then the card, then two quiet link rows beneath it; the lede is hidden. At ≥960px the body becomes two columns within 1120px: hero copy left (name + lede, vertically centred), card column right at up to 460px, one continuous ground, no imagery. Card internals stack at 20px gaps; forms at 16px.

**Workspace shell:** under 900px a sticky translucent top bar (institution name left, name plate right) and a floating thumb bar fixed 12px from the bottom and sides, respecting the safe-area inset; main content reserves 96px at the bottom. At ≥900px a 248px sticky deep-green rail on the left (institution name, nav, "Secured by UniVarse" foot) and content padded 32px. Page content caps at 980px with 24px gaps.

**Responsive data:** tables restack into two-column rows under 600px (name and number left, status right) so status is never clipped; anything wider scrolls inside its card, never the page.

## Elevation & Depth

Mostly flat tonal layering — white on sage — lifted by one soft, offset, deep-green-tinted shadow. Shadows are always offset downward with negative spread; there is no zero-offset halo and no hard border on cards.

### Shadow Vocabulary
- **Card rest** (`box-shadow: 0 1px 2px rgb(72 85 80 / 0.06), 0 8px 24px -12px rgb(72 85 80 / 0.18)`): Cards and the trust pill.
- **Raised** (`box-shadow: 0 2px 4px rgb(72 85 80 / 0.08), 0 18px 40px -16px rgb(72 85 80 / 0.28)`): Things floating over content — the step-up dialog and the phone thumb bar.
- **Action lift** (`box-shadow: 0 1px 0 rgb(72 85 80 / 0.12), 0 6px 16px -8px rgb(120 160 40 / 0.55)`): Under the lime action button only.

### Named Rules
**The Two Heights Rule.** Content rests (card); overlays float (raised). Nothing else gets its own elevation.

## Shapes

Soft, friendly corners scaled to the object: 10px for small controls (field toggle, skip link), 14px for buttons, inputs, code cells, notices and the name-plate tile, 22px for cards, the dialog and the thumb bar, and full pills for chips, tracks and the trust mark. Icon tiles, the welcome seal and the switch thumb are true circles. Borders appear only where a control needs a visible boundary (1.5px field outline) or as a hairline row divider. Icons are an authored set on a 24px grid, 1.75 stroke, round caps and joins, currentColor.

## Components

### Buttons
Tactile and plain: a 48px-tall rounded block that presses in.
- **Shape:** gently rounded (14px), min height 48px, 0 24px padding, Poppins 600 1rem.
- **Action (primary):** lime fill, deep-green label, action-lift shadow. Hover (pointer devices only) to lime-strong; active scales to 0.98. One per screen.
- **Disabled action:** off-white fill, muted grey-green label, 1.5px hairline inset; no lime.
- **Quiet:** sage-leaf fill, deep label; hover to a slightly deeper sage. Used for secondary actions (copy, sign out).
- **Plain:** text-only, underlined (1px, 2px on hover), 500 weight, 44px tall, left aligned; for "Change account", "Send a new code".
- **Pending:** a 18px currentColor spinner precedes the label; `aria-busy`.
- **Focus (all):** 3px deep-green outline, 3px offset (lime on the deep rail).

### Chips
- **Trust pill:** white, card shadow, 32px tall, caption 500, UniVarse mark at 18px.
- **Status:** pill, caption 600; "on" is lime-wash/deep, "off" or "not in plan" is sage-leaf/muted.

### Cards / Containers
- **Corner Style:** 22px.
- **Background:** white on the off-white ground.
- **Shadow Strategy:** card rest (see Elevation).
- **Border:** none.
- **Internal Padding:** 24px, 32px from 640px up.

### Inputs / Fields
- **Style:** white, 1.5px field-outline border, 14px corners, 52px tall, 16px text; label above (500), hint below (caption, muted).
- **Focus:** border turns deep green with a 3px deep-green ring at 22% opacity.
- **Error:** border turns danger; message below with an alert icon, linked by `aria-describedby`.
- **Password:** 44px show/hide toggle inside the right edge, sage hover.

### Navigation
- **Phone thumb bar:** floating white bar, 22px corners, raised shadow; items are icon over 12px label, 52px tall, 16px corners. Current item is a lime block with deep label.
- **Desktop rail:** deep-green column, 248px; items 48px tall with icon and 15px label in rail-mist; hover a faint white wash; current item lime with deep label.
- **Name plate:** 40px deep tile with lime initials, name (600) and number (caption, tabular), then a quiet sign-out button. Under 480px only the initials remain.

### Code Field (signature)
One real input drawn as six fixed one-digit cells (4:5 aspect, 8px gaps, max 360px). Empty cells are off-white with a field outline; filled cells turn white; the active cell gets a 2px deep inset, a soft deep ring and a blinking caret. Invalid turns every cell's outline danger. Paste, autofill (`one-time-code`) and screen readers all go through the hidden input.

### Expiry Bar (signature)
A 6px sage-leaf track with a deep-green fill whose length is the exact time left, draining linearly; a clock icon and plain words ("Valid for 15 more minutes") always accompany it. Under reduced motion the bar stops animating; the words remain.

### Step Strip
A row of 4px pill bars with caption labels beneath; done and current bars are deep green, the current label goes deep and 600. Each flow keeps one card frame and the strip shows the stage.

### Notices
Tinted panel (14px corners, 16px padding) with an 18px icon; danger notices are `role="alert"` and carry a "Support reference" line. No coloured side stripe.

### Icon Tiles and Moments
Round 44px lime-wash tiles carry a deep icon beside headings and list rows. Completion moments use a 64px lime-wash mark (20px corners) or an 88px lime-wash seal with an inner white ring, popping in with the ease-out curve.

### Switch
A 52×30 pill track with a 22px thumb. Off: sage-leaf track, field-outline inset, white thumb. On: lime track, deep inset, deep thumb slid 22px. Paired with an "On"/"Off" word.

### Step-up Dialog
Native dialog, max 440px, 22px corners, raised shadow, 24px padding; backdrop deep at 55%. Rises 16px and fades in over 280ms.

## Do's and Don'ts

### Do:
- **Do** put the institution's name at display size above or beside the task card, and UniVarse only in the trust pill or the rail foot.
- **Do** give every screen exactly one lime action, with a deep-green label.
- **Do** use lime-wash, not lime, for done, on and icon-tile states.
- **Do** keep every touch target at 48px (44px minimum for plain and icon controls).
- **Do** pair every status colour with words and an icon; give every error notice a support reference.
- **Do** use the ease-out curve (cubic-bezier(0.16, 1, 0.3, 1)) at 140–280ms for state changes, and honour reduced motion.
- **Do** show time limits as the expiry bar plus words, never a countdown alone.

### Don't:
- **Don't** use lime as text, an icon or a focus ring on a light surface (1.37:1 on white).
- **Don't** put a border on cards or a zero-offset glow on anything.
- **Don't** set any input text below 16px.
- **Don't** fake an institution crest or let UniVarse out-scale the institution's name.
- **Don't** use jargon ("MFA", "TOTP", "tenant") in user-facing copy.
- **Don't** use colour alone to carry status.
