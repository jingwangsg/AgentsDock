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

## Components and design

The SDK includes Markdown, Stack, Row, Grid, H1/H2/H3, Text,
Card/CardHeader/CardBody, Table, LineChart, BarChart, PieChart, Callout, Stat,
Pill, DiffView/DiffStats, TodoList, UsageBar, form controls and
computeDAGLayout. Exact signatures are in the declarations.

Write the prose with `Markdown`: one Markdown string per section gives
headings, paragraphs, lists, code blocks, links and tables in the host's
typography. Formulas written as `$…$` or `$$…$$` are shown as TeX source, so
also say in words what each formula states; a literal dollar sign is written
`\$`. A table typed into the prose stays in Markdown; use `Table` when rows
come from a data array or respond to a filter. Gather the key numbers of the
report in one summary table with value, unit and source. Use Callout only for
a caveat the reader must not miss, Pill only for a status word in a row, and
Stat only when the user asked for a dashboard of live metrics. Add a chart
where a trend or distribution is the finding.

Use `useHostTheme()` for colors: `theme.text.primary`, `theme.text.secondary`,
`theme.bg.editor`, `theme.stroke.primary`, `theme.accent.primary`,
`theme.status`, and `theme.category`. Keep the layout a readable document: a
title, a short summary, numbered sections, the findings stated in prose next to
their evidence. Avoid decorative gradients, shadows, emojis, oversized
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
