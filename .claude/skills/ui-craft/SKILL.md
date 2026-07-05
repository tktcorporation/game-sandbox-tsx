---
name: ui-craft
description: Design and build high-quality, non-generic UI that doesn't look "AI-generated". Use whenever creating or restyling any interface, component, theme, or design system — especially when output looks generic, templated, or like default glassmorphism. Enforces explicit design intent, a real type/space/color system, genre-appropriate art direction, and tactile feedback.
---

# UI Craft — make interfaces that look intentional, not generated

The reason generated UI looks "AI" is **absence of intent**: it reaches for whatever
is statistically safe (glassmorphism, blue→purple gradients, floating cards, soft
shadows on everything, Inter/Roboto, neon glows, "clean & modern"). Every one of
those can be fine — but as a *default*, with no reason behind it, they read as generic.

Quality UI is the opposite: **every choice has a reason**, choices come from one
coherent art direction, and they're built on a real system instead of ad-hoc values.

Work in this order. Do not skip Step 0 or Step 1.

## Step 0 — Kill the AI tells (negative constraints)

Before designing, explicitly rule these out unless there is a *specific* reason:

- ❌ Dark glassmorphism / frosted panels as the default chrome.
- ❌ Blue→purple (or teal→purple) gradients. ❌ Neon glow on every element.
- ❌ Inter / Roboto / Open Sans / system-ui as the "design" font (fine for body,
  never the thing that gives character).
- ❌ Everything the same border-radius, same soft shadow, same weight — no hierarchy.
- ❌ Emoji as primary iconography in a polished product.
- ❌ "Clean and modern" as the brief. It means nothing. So does "sleek", "premium".
- ❌ Perfectly even, centered, low-contrast layouts where nothing dominates.

A design that merely avoids these is not yet good — but one that includes them
by default is already generic.

## Step 1 — Commit to intent BEFORE any pixels

Write one or two sentences answering these. If you can't, you're not ready to style.

- **Who & what**: who uses this, what are they trying to do, on what device?
- **Personality** (pick 3 adjectives, concrete not vague): e.g. *warm, chunky,
  hand-made* — or *crisp, confident, editorial* — or *cozy, soft, storybook*.
- **Art direction**: name a real reference world, not "modern". For a game, match
  the **genre and the in-world art** (a sunny fantasy base-builder → wood / stone /
  parchment / gold, not a sci-fi HUD). The UI should feel like it belongs to the
  same world as the content it frames.
- **One hero accent**: a single signature color that means "act / important".
  Everything else supports it.

The single biggest lever against the AI look is choosing a **specific,
content-appropriate art direction** and committing to it everywhere.

## Step 2 — Build on a system, not vibes

Replace ad-hoc values with scales. This alone separates pro from generated.

- **Type scale** — one modular ratio (1.2 / 1.25 / 1.333). Define ~5 steps and use
  *only* those. Pair at most two families: one with **character** for
  display/headings (a real personality face), one neutral for body. Set weights
  deliberately (e.g. 800 display / 600 labels / 400 body). Tighten heading
  letter-spacing, never body.
- **Spacing scale** — a 4px base (4 8 12 16 24 32 48). Every margin/padding/gap is
  a token. Whitespace is a tool: use *more* of it to create hierarchy.
- **Color system** — neutrals (3–4 steps) + ONE hero accent + at most 1–2 semantic
  colors. Derive tints/shades from base hues so the palette feels related. Aim for
  a clear dominant/secondary/accent split (≈60/30/10). Verify text contrast (≥4.5:1
  body, ≥3:1 large).
- **Depth language** — pick ONE consistent model (flat with borders, OR soft
  elevation, OR tactile/skeuomorphic) and apply it the same way everywhere. Don't
  mix glass + skeuo + flat.
- **Shape language** — a deliberate radius set (e.g. 6 / 12 / full) used by meaning,
  not one radius on everything.
- **Motion** — fast (120–220ms), eased, and *physical*: press states that actually
  depress, springy enters. Feedback on every action. Motion is part of quality, not
  decoration.

## Step 3 — Component grammar & hierarchy

- Decide a primary / secondary / tertiary button treatment and never blur them —
  exactly one primary action per view.
- Strong visual hierarchy: the most important thing is the biggest / highest
  contrast / most isolated. Squint test — the eye should land in the right place.
- Align to a grid; prefer optical alignment over mathematical when they differ.
- Consistency: same component = same look everywhere. Build tokens/vars once.

## Step 4 — Games & "juicy" UI (when applicable)

- Match the in-game art direction and palette; the HUD is part of the world.
- Big, thumb-friendly targets (≥44px) with generous spacing; one obvious CTA.
- **Juice**: chunky depth, press/bounce, particle/scale pops on success, clear
  reward feedback. Satisfaction comes from feedback, not gloss.
- Characterful display type (rounded/heavy for playful, etched for epic). Custom
  icon shapes beat emoji.

## Step 5 — Review against this list

Before declaring done, check:
- [ ] Can I name the art direction in one phrase, and does every screen honor it?
- [ ] Are type sizes, spacing, and colors all from the defined scales?
- [ ] Is there exactly one hero accent and one primary action per view?
- [ ] Does the depth/shape/motion language stay consistent throughout?
- [ ] Did I avoid every Step 0 tell — or break one *on purpose* with a reason?
- [ ] Squint test: does the hierarchy read instantly?
- [ ] Does it feel like *this product*, and could a competitor's logo NOT be
      dropped in unchanged? (If it's interchangeable, it's still generic.)

The goal is not "more effects." It's **fewer, more intentional decisions, applied
systematically, in service of one clear identity.**
