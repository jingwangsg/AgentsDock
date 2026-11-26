# Canvas authoring

A Canvas is a single React/TSX document, saved in this chat's managed Canvas
directory and shown beside the conversation. It reads as an interactive
technical report: the complete content at the granularity of a written report,
with interactive parts (filters, toggles, selectable series) where the reader
needs to choose what to see. Use it for content the user will read, explore,
revisit or refine: reports, tutorials, comparisons, metrics, architecture
reviews and diagrams. Honor an explicitly requested delivery format. A code
fix, a message draft, a change in another application, or a brief answer stays
that deliverable; encountering a table during the work does not turn the task
into Canvas creation.

When the deliverable is a report or tutorial, the Canvas holds the whole text.
Do not write the text to a separate file and leave the Canvas as its index or
summary.

## Workflow

1. Gather the actual data and establish what the report needs to show. Do not
   generate a blank Canvas, example data, empty charts, or placeholder sections.
   If the necessary data is unavailable, explain what is missing.
2. Read the SDK declarations in `sdk.d.ts` next to this file. Use its actual
   exports and prop types.
3. Write one complete, descriptive `<name>.canvas.tsx` directly in the Canvas
   directory given in the system prompt. Source files outside it are ordinary
   code files, not Canvases.
4. Import only from `@zed/canvas`, including React hooks and types.
   Default-export the top-level React component. Embed data directly. Use the
   SDK's Markdown, layouts, tables, charts, forms and diffs. Raw HTML and SVG are
   available for content the SDK does not cover. Do not create helper files or
   import packages, local modules or network resources; the preview has no
   network access.
5. Run the check command given in the system prompt on the saved file and fix
   every reported error. For later changes, read and edit the same file;
   preserve existing state keys and user choices.
6. End with a short conclusion and a Markdown link to the absolute
   `.canvas.tsx` path. AgentsDock associates the artifact with this chat and
   opens its preview beside it. Do not duplicate the whole report in the chat.

## Overview diagram and navigation

Every Canvas overview must include a diagram. Place it after the motivation and
before detailed findings. Use named nodes to show the workflow, dependencies,
or structure of the report. Use arrows for actual flow or dependencies, and
group parallel work visually.

For a Canvas with subpages, put direct links to the corresponding subpages
inside each diagram node. Use the title format `Overview node · Project` in
the subpage heading and wherever its full title appears in navigation. For
example, the `Planning` node can link to `Dataset`, which opens the page
`Planning · Dataset`. Use shared node and page IDs to derive these labels and
destinations from the same data.

During preview, click through the diagram links and verify that each subpage
opens under the matching node name.

## Paper-style subpages

Only the overview may use an abstract or executive-summary style. Use it to
orient readers, state the main findings, and point to the relevant subpages.
Write each technical subpage as a full section of a paper. Develop the
argument in connected prose, with figures and tables where they support it.

1. **Background and motivation.** Explain the system and prior approach the
   reader needs to understand, the specific problem or gap, and why it matters.
2. **Method.** Walk through the proposed or reported approach in execution
   order. Explain the inputs, outputs, and what each stage does. Connect the
   design choices to the problem they address.
3. **Implementation and data.** Describe the details needed to understand
   how the method works. For a learned system, cover the training data,
   supervision or objective, and how data moves through training and into
   evaluation or deployment. For other systems, explain the equivalent data
   or execution path. Identify missing implementation details where they
   affect the interpretation.
4. **Evaluation and findings.** Explain the relevant setup, comparisons, and
   results in the body. State what the evidence supports and which questions
   remain open.

Keep the material needed to follow the argument in the subpage body. Put
longer derivations, full configurations, extra ablations, run inventories,
and extended source material in a labeled appendix. Link to the appendix
from the discussion it supports. During review, read each subpage on its own
and verify that the reader can follow the reasoning from the problem through
the method and evidence.

## Actual input and output examples

When source records are available, include one actual input and output example
in the overview and on every subpage. Place it after the method or workflow
diagram. Write each example so a reader can understand it on that page without
opening a source file or reading another page.

- Start with the task or question and the relevant starting conditions. Name
  the object, system, or decision and explain local terms where they appear.
- Show what the system actually received and returned. Include the relevant
  records or field values in the page, with labels, units, and a brief
  explanation of how to read them. For large inputs and outputs, show a real
  excerpt and say which parts it represents. Keep filenames and identifiers
  alongside the evidence they identify.
- Describe the operation between input and output. For a chain such as
  training followed by evaluation, show what each stage receives and produces.
  For a measured result, define success, the population tested, and the
  denominator. Distinguish an output the system returns from a score computed
  afterward.
- Give the original record or run reference after the example for verification.
  If only part of the operation is documented, identify the missing input,
  output, or stage and show the part supported by the record.

## Components and design

The SDK includes Markdown, Stack, Row, Grid, H1/H2/H3, Text,
Card/CardHeader/CardBody, Table, LineChart, BarChart, PieChart, Callout, Stat,
Pill, DiffView/DiffStats, TodoList, UsageBar, form controls and
computeDAGLayout. Exact signatures are in the declarations.

Write the prose with `Markdown`: one Markdown string per section gives
headings, paragraphs, lists, code blocks, links and tables in the host's
typography. Formulas written as `$…$` or `$$…$$` are typeset with KaTeX; TeX
that KaTeX cannot parse is shown as source. A literal dollar sign is written
`\$`. A table typed into the prose stays in Markdown; use `Table` when rows
come from a data array or respond to a filter. Gather the key numbers of the
report in one summary table with value, unit and source. Use Callout only for
a caveat the reader must not miss, Pill only for a status word in a row, and
Stat only when the user asked for a dashboard of live metrics. Add a chart
where a trend or distribution is the finding.

Use `useHostTheme()` for colors: `theme.text.primary`, `theme.text.secondary`,
`theme.bg.editor`, `theme.stroke.primary`, `theme.accent.primary`,
`theme.status`, and `theme.category`. Use a title and numbered sections to
make the document easy to navigate. Keep findings in prose next to their
evidence. Avoid decorative gradients, shadows, emojis, oversized
standalone numbers and uniformly repeated cards. Every plot needs a specific
title, axes and units,
series names, and a source/time-range caption. Explain aggregations such as
averages or percentiles.

Use `useCanvasState(key, initialValue)` for JSON state that should survive edits
and reopening, such as filters, selected runs or checked items. Choose stable
keys; use a new key when a stored value's shape changes. Ordinary `useState` is
for transient state. Add stable `data-canvas-id` attributes to important
HTML/SVG sections so element feedback is identifiable.

`useCanvasAction()` returns a dispatcher.
`dispatch({type: 'askAgent', prompt: 'Refresh the source data for this report'})`
adds the Canvas reference and request to the chat's draft; the user sends it.
File navigation is available through `openFile`; no action can execute commands
or directly send a message.

Saved source, a passing check, and a loaded preview are distinct. If the preview
has an error, the user can bring its diagnostic back to you. Correct the source of
that artifact, preserving its identity and data provenance.
