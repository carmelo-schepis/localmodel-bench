---
version: 2
name: LocalModel Bench
description: "A full-bleed black instrument for benchmarking local models. Structure comes from alignment and hairlines, not boxes. Colour is reserved for what needs attention."
colors:
  black: "#000000"
  ink: "#ffffff"
  ink-2: "#a8a8a8"
  ink-3: "#7a7a7a"
  line: "#202020"
  line-2: "#383838"
  wash: "#101010"
  signal: "#ff5c7a"
typography:
  family: "Mona Sans (variable, bundled in frontend/assets/fonts)"
  mono: "System monospace, for model IDs, URLs and model answers only"
  display: "500 weight, 125% width, -0.035em tracking"
  body: "15px/1.5"
---

# LocalModel Bench design

## Principles

1. **Black means black.** The page is `#000`. Do not substitute a tinted near-black. Do not add a second surface colour to separate content; use a hairline or space.
2. **No cards.** Content sits directly on the canvas and runs to the window edge. Boxes are for controls only: buttons, the depth switch and checkboxes.
3. **Use the width.** There is no maximum page width. Lists reflow into more columns and tables fill the window, with `--gutter` as the only side margin.
4. **Colour is a signal.** Interface and data are monochrome. `signal` means only that something failed or scored below 50%. Never use it for decoration, and never rely on it alone.
5. **Say it with type.** Hierarchy comes from size and width. Large figures use Mona Sans at 115% width. Do not use `tabular-nums` here, because its slashed zero reads as a monospace label.

## The attempt tape

The tape is the signature of the interface. Each model has one lane, and each mark is one attempt. Models run the same task list in the same order, so a column is the same task across models.

Outcomes are encoded by shape as well as colour:

| Outcome | Mark |
| --- | --- |
| Match | Full height, white |
| No match | Short, `signal` |
| Ungraded | Medium, grey |
| Error | Full-height `signal` outline |
| Not run | Baseline dash |

A lane shows at most 240 marks. Larger runs group attempts into one mark that shows the worst outcome in the group. Selecting a mark opens that attempt in the inspector.

## Views

- **Bench:** A wide pane to connect endpoints and choose models, beside a fixed run setup rail. The headline shrinks once an endpoint is connected, so the model list gets the room.
- **Runs:** One full-width table. The whole row opens the run.
- **Run (`#run/<id>`):** Heading and progress, the tape, then scores beside the attempt inspector.
- **Compare:** A run picker, the score matrix, and timing and tokens per category.

## Writing

Use sentence case and plain verbs. Keep an action's name the same through the flow. Name results for what the grader did: "Match" and "No match", not "Pass" and "Fail". Keep the smoke-test notices wherever scores appear; they state real limits of this release.
