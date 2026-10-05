---
version: 1
slug: "src-app"
primary_target: "src/app"
related_targets: ["src/app/(auth)","src/app/(workspace)"]
---

# Surface brief: tenant sign-in journeys and workspace shell

Scope: `apps/web` sign-in screens (login, two-step verify, activation, password reset, two-step setup, step-up dialog) and the signed-in workspace shell. Mode: **Operate**.

Audience and job: students (mostly on low-end Android, weak data), staff and IT Admins of one institution, signing in on that institution's address. One task per screen: sign in, activate, recover, set up two-step, or confirm identity before a sensitive action. Constraints: PRODUCT.md (the institution leads; warm, plain voice; no jargon), spec 0005, WCAG 2.2 AA measured, ≤ 170 KB JS per student route, nonce CSP.

Avoid (user, 2026-10-05): generic SaaS template, cold bank/fintech, heavy on phones. Most care: **first activation**.

## Direction contract

THESIS: Signing in to your institution feels like opening a friendly app you already trust: one idea per card, plain words, lime only where you can press. It refuses the centred grey-card login and cold security theatre.

OWN-WORLD:
- Sage off-white ground (#F4F6F0) with borderless white cards with soft offset shadows, 22px corners.
- Deep-green ink (#485550) at real, generous sizes. Poppins 600 for display, 400/500 for text.
- Lime (#C0EB6A) only on pressable things, always with deep-green labels.
- 48px touch targets. Small round icon tiles on pale green. A thumb bar on phones.

STORY: The visitor sees their institution's name first and knows the single next step. They learn in plain words what just happened ("We sent a 6-digit code to a••••@demo-uni.test") and how long they have. They arrive in a workspace that greets them by name and shows what they can do.

FIRST VIEWPORT:
- **Decision (finish review, 2026-10-05):** the greeting "Welcome back" is the card's own h1 (the task heading screen readers land on). The institution name stays the hero above the card, and the oversized UniVarse watermark was removed so UniVarse never out-scales the institution.
- **Login, phone 390px:**
  - Top row: the UniVarse mark and a "Secured by UniVarse" pill.
  - Then the institution's full name as the hero (Poppins 600, ~32px), under the greeting "Welcome back".
  - One white card: username, password, and a full-width lime "Sign in".
  - Below the card, two quiet rows: "First time here? Activate your account" and "Forgot your password?".
- **Desktop:** hero copy left (institution name at ~56px), card right, one continuous ground, no photo.

FORM: Warm consumer app surface (catalog `digital-design-canon-warm-consumer-app-surface`), chosen by the user as the competitive challenger of seed `9238a34b`.
- **Kept from the declined hand:**
  - Codes in fixed one-digit cells (split-flap).
  - Each flow in one fixed card frame with a step strip (botanical folio).
  - Time limits as bars of the exact time left (labanotation).
  - A personal name plate in the workspace header (character catalog).
- **Signature interaction:** the 6-digit code entry. Fixed cells, paste-to-fill, auto-advance, and a deep-green expiry bar that drains in real time. (Lime would fail non-text contrast on white and break "lime is a button".)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
