# AgentsDock iOS/iPadOS Parity

The mobile client uses the same server contract, session identity, runtime
catalog, queue, jobs, files, and unread cursors as the Electron desktop client.
Platform-specific presentation may differ, but a chat must remain operable from
either client without losing capabilities or state.

## React Rewrite Audit

This table is the source of truth for the React rewrite. `Working` means the
capability has both a UI path and an implemented store/server path. `Partial`
means data or APIs exist but the complete user workflow is not wired. The audit
was refreshed on 2026-07-12 against the old Swift iOS client and the Electron
desktop client.

| Capability | Status | iPhone and iPad behavior |
|---|---|---|
| Chat lifecycle | Working | Create, resume by provider ID, fork, rename, archive, delete, pin, move between folders, and stable move-up/down ordering. |
| Chat action menu | Working | Android's long-press dropdown menu (drawn by the app on iOS) plus swipe actions for pin/archive/delete; read/unread and folder moves are included. |
| Folder management | Working | Create folders from the sidebar, fold sections, and long-press a folder header to move it up or down. |
| Runtime selection | Working | Server-populated Claude/Codex models and effort levels; backend locks after a provider session starts. |
| Queue | Working | Edit, reorder, remove, run-now/steer, stop, and attachment retention on send failure. |
| Timeline | Working | Cached latest page, live incremental events, older paging, Markdown/tables/code, full-text copy/folding, grouped traces, jobs, errors, and media. |
| Whole-history search | Partial | Server-wide content search and name-first ranking work. A result opens the right chat, but exact event reveal is not wired yet. |
| Timeline landmarks | Partial | The server index is fetched and cached, but the React UI does not yet expose the navigator or exact landmark jumps. |
| Pins | Partial | Message/file pin state, visual feedback, full-message preview/copy, file preview, and unpin work. Exact reveal in the timeline is not wired yet. |
| Code review | Working | Canonical per-turn patch, file list, additions/deletions, line-oriented diff, and copy-complete-diff. |
| Files and media | Partial | Paged metadata, image/video preview, gallery navigation, native share/download, and latest-first browser work. Find-in-chat and iPad drag-in/drag-out are not wired yet. |
| Scheduled jobs | Working | Create/edit, fixed or looping runs, first-run time, enable/pause, run now, refresh, and delete. |
| Live processes | Partial | Process details, command/path copy, snapshot stdout, refresh, and copy stdout work. Selecting arbitrary attached logs for tailing is not wired yet. |
| Tmux submitters | Working | Chat-linked or machine-wide pane list plus on-demand captured output and copy. |
| Persistent terminal | Working | The xterm.js web view Android uses, attached to per-chat server tmux and to terminal tabs, with windows, splits, navigation, close, copy, paste, find, zoom, key row, keyboard focus, and reconnect. |
| Digest handoff | Working | Source-agent preview/generation, detail level, user prompt, archived-target filtering, and send to target chat. |
| Notifications and badges | Working | Background agent notifications and per-chat unread badge count use server read cursors. |
| Settings | Partial | Server address/token and automatic system appearance work. Explicit appearance and notification preferences are not wired yet. |

## Platform Rules

- iPhone and iPad open sheets full screen and dialogs as a centered card, as
  Android does (since the October 27, 2026 pass below).
- iPad uses split panes where the extra width materially improves operation.
- TestFlight remains the updater for iOS/iPadOS; Electron self-update is a
  desktop-only capability, not a missing mobile feature.
- Mobile never downloads every attachment eagerly. Preview/share requests
  populate the bounded local file cache on demand.

## Verification

- TypeScript must pass before every native build.
- Both compact iPhone and regular-width iPad simulator builds are required for
  parity changes; menus, sheets, keyboard behavior, and terminal focus must be
  exercised in each size class.
- A feature stays `Partial` until its end-to-end UI behavior is exercised. API
  presence or a cached store value alone does not count as delivery.

## September 9, 2026 focused parity pass

This is a targeted update against the latest Mac cross-chat renderer, not a
claim that every item in the older rewrite audit is now complete.

- Complete imported Codex/Claude cross-chat deliveries use the shared purple
  Agent conversation surface and incoming bubble. The prepared message renders
  compact Markdown; Source request is initially collapsed. Long bodies and source
  requests have independent Show more/less controls. Terminal status, including
  a valid zero-leg notice, uses a neutral Status update row.
- Import recovery requires the same provenance and complete-envelope checks as
  Mac. It does not create routes, reply controls, or permissions from sender
  text. Ordinary quoted examples remain ordinary user messages. Attachments and
  the following assistant answer retain their separate timeline rows.
- Validation happens before mobile prompt truncation. Retained source/body text
  stays within the existing 48,000-character prompt limit and can be parsed again
  after cache hydration. Previously clipped cached envelopes cannot be recovered
  without a fresh complete history event.
- Expanded live conversations now use the same compact Markdown renderer and
  preserve the selected chat font scale. Existing detail-loading, cancellation,
  and exact queued-delivery controls retain their connection-scope guards.
- `@@` opens the Team Network server-inbox picker through the active server's
  approved proxy. Search is local after discovery; loading, retry, and unsupported
  connection states are visible. Add -> Reference a server and a switch inside
  the local-chat picker avoid depending on fast double-`@` typing. Exact selected
  recipient identities survive draft persistence, failed sends, and queue edits;
  stale connections and ambiguous edits cannot silently change a recipient.
  This pass supports server inbox recipients, not Mac-only human/Bulletin/skill
  references. Queued messages using unsupported reference kinds fail closed.
- Download now asks for a destination folder before requesting file bytes. The
  timeline, artifact viewer, and workspace viewer show transfer progress, Cancel,
  completion, and errors locally. Share is separate. Downloads preserve readable
  names, avoid overwriting existing files, and clean failed/cancelled staging.
  Mutable workspace files are not rejected using an older browser size.
- Fifteen actual Composer interaction tests and seventeen store/API/persistence
  tests exercise `@@`; thirty-four rendered download scenarios cover twelve
  entry points, and fifteen pure transfer tests cover ordering and lifecycle.
  These use synthetic native/network boundaries, not real user messages or
  downloads. Files/iCloud providers and physical-device large-file throughput
  still need device acceptance; no speed improvement is claimed from UI tests.
- Runtime component tests cover light/dark presentation, source and body
  toggles, recycled-row state, attachments, following replies, literal-user
  fallback, and bounded cache hydration. An isolated unsigned Release arm64 iOS
  fixture also compiles. Native runtime/pixel acceptance remains pending:
  macOS removable-volume privacy denied CoreSimulatorService access to the
  external device set. No internal-disk device set, privacy-setting change, or
  interaction with the user's installed Mac app was used as a workaround.

## October 27, 2026 Android parity pass

The iOS app (iPhone and iPad) was brought to Android build 78's screens and
features. Android's rendering and behavior did not change.

- Menus, alert dialogs, the spinner, switches, the job date and time pickers
  and pull-to-refresh are drawn by the app on iOS in Android's Material style
  (`src/components/material/`, `src/lib/alert*.ts`). iOS shows every alert
  button (Android's dialog drops buttons after three) and adds a Cancel where
  an Android dialog relies on Back or an outside tap. A test keeps new code on
  these shims.
- Sheets open full screen and the Settings, Connect, Search, digest, job,
  process and tmux dialogs open as Android's centered card. Search fields have
  no clear button, the timeline keeps the keyboard while dragged, PDFs use the
  bundled pdf.js viewer, and selectable text has range selection handles.
- The terminal is Android's xterm.js web view, with the same toolbar, key row,
  find bar, settings, hidden-tab behavior and attach/ack/replay rules. iOS draws
  it with Android's Droid Sans Mono. The SwiftTerm view was removed.
- Browser tabs load pages through the server's per-tab port tunnel (a SOCKS5
  listener per tab on iOS 17+) and keep their own cookies and storage
  (`WKWebsiteDataStore(forIdentifier:)`). WebKit sends literal `127.0.0.1` and
  `[::1]` URLs around any proxy, so those addresses reach the phone itself.
- Video tiles show a frame thumbnail read without a player, and the viewer has
  Android's zoom buttons and loading and error views. iOS keeps its download
  before playback and AVKit's transport controls.
- The launch screen uses Android's background and app mark.
- Not copied: the Android sideload updater (TestFlight updates iOS), Android
  usage analytics (removed from iOS for its privacy manifest), Android's
  keyboard resizing mechanics, the Android-only non-selectable math and image
  paragraphs, and overscroll physics. System UI stays native.

Verification: iOS 27.0 simulators (iPhone 17 Pro, iPad Pro 13-inch), light and
dark, against isolated servers, side by side with build 78 on an Android
emulator; a 56-screen phone tour and a 16-screen tablet tour of the Android
build of the same JavaScript compared pixel by pixel with build 78. Needs a
real device: the paste permission prompt, pinch zoom, rotation and Split View,
haptics, memory with eight kept terminal tabs, a terminal after a long
suspension, typed `127.0.0.1` browser addresses, and iOS versions before 27.
