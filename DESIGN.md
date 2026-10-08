---
name: Lecture Notes Studio
colors:
  primary: "#1d5f53"     # ink green, the single accent
  primaryInk: "#164a41"
  record: "#c8372d"      # recording state only
  background: "#f6f5f1"
  surface: "#fffefb"
  text: "#1c1b18"
  textMuted: "#5d5a52"
  line: "#e2dfd6"
  dark:
    background: "#141412"
    surface: "#1b1b18"
    text: "#ecebe6"
    primary: "#5fb3a1"
    record: "#ef5a4f"
typography:
  sans: '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", -apple-system, system-ui, sans-serif'
  mono: '"SF Mono", ui-monospace, Menlo, "JetBrains Mono", monospace'
  heading: { weight: 700, tracking: "-0.02em", wrap: balance }
  body: { size: 16px, lineHeight: 1.6, measure: 65ch }
iconography:
  system: "Phosphor"
  weight: "regular"
  domain: "custom-ima2 (logo mark only)"
---

Reading this as: an open-source developer tool for students and engineers who already run a local OpenCodex proxy,
in the language of a well-kept lab notebook rather than a startup splash page.

- The product UI is the stage: real screenshots, real timestamps, real commands. No styled-div fake previews.
- One accent (ink green). Red appears only where something is recording.
- Mono is for time and commands only.
- Paper-like warm neutral is inherited from the shipped app; it is the product's existing system, not a decorative choice.

Do: show the recording-to-notes loop, the privacy boundary (everything stays on this machine), and the two-line quick start.
Don't: gradients, glow, emoji, equal three-card feature rows, split hero with a boxed mockup, version badges in the hero.

## Logo

The mark is an ink-green rounded page with a white record dot whose sound continues as lines of notes, plus a small
coral recording light. Use the mark alone at small sizes (favicon, sidebar); pair it with the wordmark
"Lecture Notes Studio" set in the sans stack at weight 700 elsewhere. Minimum size 16px; keep clear space equal to the
dot's radius. On dark backgrounds the page stays ink green; never recolor the record light.

Dials: DESIGN_VARIANCE 6, MOTION_INTENSITY 4, density D3 (landing). App surfaces stay D4.
