# Native side conversations

Side chat uses the provider's conversation context, not a projection of the
desktop timeline. No main turn, queue item, goal mutation, or provider-history
import is created by a side question.

- Codex: `thread/fork` with `ephemeral: true`, reusing that fork for follow-ups.
  Its dedicated app-server process uses the parent's workspace and selected
  permissions. Like native Codex Side chat, it can read/search files, run
  non-mutating checks and use configured tools. Inherited tasks and approvals
  are reference context; mutations require a new explicit request in Side chat.
  Subagents remain unavailable. Native approval requests use the existing
  approval UI and belong only to the ephemeral child. The main run's internal
  AgentsDock helper transport and credentials are not inherited. The source
  thread is never resumed, interrupted or modified.
  Where the server stores the side conversation, as it does for the composer's
  Side chat, the fork is saved instead of ephemeral, so that it can be resumed
  after its process was closed.
- Claude: native `side_question` control (the `/btw` operation) on the exact
  chat-owned SDK connection. Only connection acquisition is actor-serialized;
  waiting for a side answer never occupies the main-turn actor. Cancellation
  addresses only its control request. Cold connections must resume the exact
  parent identity; an empty conversation is not an acceptable fallback.
  A connected parent keeps its current settings for side questions, even if
  saved model or effort settings have changed for the next main turn.

- Cursor: the CLI has no side chat and no fork. Every question runs the CLI
  once on a new copy of the chat's native session as it stands, in the CLI's
  ask mode and on the model that a turn of the chat would run. The copy and
  what the run leaves are deleted when the answer returns, and also when the
  question is cancelled or fails. The server records the copy before it makes
  it: a recorded copy is not offered in Import Chat, and a copy that outlived a
  server which ended during the run is removed when the server next starts
  ("Copies of a session" below). Nothing is kept on the provider's side
  between questions, so the server puts the side chat's earlier exchanges in
  front of the question, each earlier answer cut at 20,000 characters, the
  bound of a Canvas comment's reply. In front of those it puts one sentence
  that says that this is a question in a read-only side chat: the CLI resumes
  the copy as the chat itself and does not know otherwise. Measured without
  the sentence: a follow-up was answered from the chat's own last reply, and a
  request for a change with "switch to Agent mode". The chat's own session is
  only read, and it can be in the middle of a turn. The same copy mechanism
  answers Canvas comments, see below.

  Ask mode is the CLI's read-only mode. Measured with CLI 2026.11.22: the agent
  reads and searches files and runs shell commands that only read (`ls`, `ps`);
  asked to edit a file or to run a command that writes, it answers that the
  mode does not allow it and makes no tool call. The mode's restriction is
  therefore the CLI's, not one this server enforces. Whether a command that
  only reads is run is the agent's decision too: one run declined
  `sleep 12; wc -c notes.txt`. A side question raises no approval request, and
  its steps are not reported.

  A question's run can execute shell commands, so its environment holds none
  of the chat's own coordinates: no chat id, no helper commands, no terminal
  session. The run of a Canvas edit request keeps them, because it needs the
  Canvas directory.

  What "read-only" rests on for a Cursor question, as measured facts:

  - The chat's session is protected by the copy. The server opens the chat's
    store read-only to make the copy, and the CLI writes under the copy's id:
    the copy's store, and its transcript in `agent-transcripts/<copy id>`.
  - The run gets none of the chat's authority. Its environment has no
    `AGENTSDOCK*` variable, so no chat id, no helper command and no provider
    authority file, and its command has no `--plugin-dir`, so none of the
    server's MCP tools.
  - The workspace is protected by the CLI's ask mode alone. The process runs
    as the server's user in the chat's directory, without a sandbox. Measured
    with CLI 2026.11.22 in five runs that asked for a file to be created, by
    a shell command or by the edit tool: the agent named the ask mode notice
    in its instructions, attempted no tool call, and no file was created. What
    the CLI does with a write that an agent attempts in ask mode was not
    observed.
  - The server takes no git baseline for a side run and appends no event to
    the chat. A write by the CLI would be neither prevented nor recorded.

  The workspace's `.cursor/cli.json` applies to a question's run as the CLI
  applies it natively. The CLI accepts permission lists in that file and no
  other key. Measured with CLI 2026.11.22: an allow list (`Shell(*)`,
  `Write(**)`) did not make an ask-mode run create a file; a deny list
  (`Shell(wc)`) blocked a command that only reads, and the same command ran
  when the run was started with `--disable-project-configs`. A turn passes
  that flag because it passes the same lists itself, merged with the entry for
  the server's own MCP tool. A side run has no such tool and so needs neither;
  the flag alone would drop the workspace's deny list.

The desktop requires `side_questions.version: 2` and `native_context: true`.
Each request supplies `request_id`, `side_chat_id`, `question`, and, for a
follow-up, `after_request_id`. The server deduplicates receipts and verifies
the predecessor before asking the provider. Client-authored history is refused.
Claude receives its native maximum of twenty server-owned side exchanges;
Codex retains its own ephemeral transcript. No parent text budget is applied.
Codex captures the main context on its first question; Clear starts a new fork
with the latest main context. Its workspace tools can inspect current files
even when the inherited conversation predates those files.

`side_questions.backends` lists the backends whose chats this server answers
the composer's Side chat for, and the apps offer Side chat for those;
"Carriers" below says where the list comes from. A Cursor question carries the
side chat's last twenty exchanges, the number Claude replays. It sees the chat
as it stands when the question is sent, so a follow-up also sees what the chat
did in between; Clear removes the side chat's exchanges.

`DELETE /api/sessions/{session}/side-questions/{request}` cancels one request.
`DELETE /api/sessions/{session}/side-chats/{side_chat}` closes the side chat.
Both are native-operator-only and scoped to the authenticated owner and parent.
Clear, profile shutdown and server shutdown release owned resources. Idle side
contexts expire after thirty minutes without polling; stale follow-ups receive
410 rather than silently starting with different context. Cancellation/error
also closes the side conversation; the user can Clear to start again.
A Cursor side chat ends with 410 once the chat's native session is another one
than at its first question.

Tests must cover real tool-result context, successive questions, cancellation
with a running parent, unchanged parent goals/transcripts, native cold resume,
HTTP ownership, request deduplication and Clear arriving before a delayed POST.
Never import the production server or use a real user chat in test setup.
`tests/test_side_chat_carriers.py` runs both entry points against a carrier
that exists only in the test: it is the check that a backend needs a carrier
and nothing else.

## Carriers: one interface for every backend

Two things ask for a side answer: the composer's Side chat and a Canvas comment
thread. One thing produces it: the backend's carrier, a class that implements
`side_questions.SideChatCarrier`. `SIDE_CHAT_CARRIERS` in `agent_server.py`
maps a chat's backend to its carrier class, and it is the only place the
callers consult to find one. Everything else reads what the carrier says:

- `health` lists a backend in `side_questions.backends` while its carrier has
  `composer` and `usable()` is true. The apps offer Side chat for that list.
- `create_native_side_chat` binds a side conversation to the chat and makes its
  carrier. The side chat stores call it for the composer.
- `create_canvas_comment_side_chat` and `canvas_comment_side_chat_available`
  do the same for a comment thread.

A new backend implements the class and adds one entry to the map. It does not
touch the routes, the stores or the Canvas code. The interface does not assume
a CLI, a process or a copied session. A new backend does not subclass
`CopiedSessionSideChat`: that class is the carrier of Cursor and Gemini, and
the last branch of its `ask` builds the Cursor command. In the apps the Side
chat button follows the server's list; the text that describes the side chat
names the backends, so a new one is added there.

### What a carrier provides

A carrier has to define `provider_id` and `ask`. Every other member has a
default in the base class.

Class level, asked without an instance:

| Member | Default | Meaning |
| --- | --- | --- |
| `composer` | True | Answers the composer's Side chat. False: Canvas comment threads only. |
| `side_aware` | True | The provider knows that it answers beside the chat: a native side question, a fork that the carrier instructs. False: the provider is the chat's own CLI on a copy; the composer then says in the question that it is a read-only side question. |
| `approvals` | False | A run can wait for an approval. See "Approvals". |
| `usable()` | True | Whether this server can run the backend at all, from server state such as the runtime check. |
| `provider_id(session)` | none | The id of the chat's provider conversation, empty before it exists. |
| `provider_revision(session)` | None | What else must stay as it is for a side conversation to go on (Codex: the credential of a custom endpoint). |
| `available(session, question, edit=...)` | `provider_id` is not empty | Whether this server can answer this message for this chat now. Asked per mode: question or edit request. |

Instance level:

| Member | Default | Meaning |
| --- | --- | --- |
| `ask(question, history=..., edit=False, on_step=None)` | none | Answers one message and returns `{"answer", "context_note"}`. `context_note` is one line about the context the answer came from; the desktop shows it under the side chat's description. |
| `lacks(history, edit=False)` | True when `history` is not empty | Whether the provider would answer the next message without these earlier exchanges. |
| `check(session)` | passes | Raises `SideQuestionError` when the carrier cannot go on for the chat as it is now. |
| `close()` | does nothing | Ends the carrier: releases what it holds in the server. |

The constructor is the base class's. It gives the carrier `session_id`,
`binding` (`backend`, `parent_id`, `provider_revision` of the chat when the
side conversation started), `current()` (the chat's session now; it raises once
the side conversation cannot go on), `durable`, `persisted_state` and
`persist_state(value)`.

### State and lifetime

A side conversation is what the server stores: the exchanges, and what a
carrier saved for it. A carrier answers its messages for a while. The server
makes a carrier at a message that finds none, for the chat's provider
conversation as it is then, uses it for the messages that follow, and awaits
`close()`:

- after thirty minutes without a message;
- after a message that failed or was cancelled;
- on Clear;
- when the chat is removed;
- at server shutdown.

`close()` ends the carrier, not the side conversation. It releases what the
carrier holds in the server: a process, a connection, files. It is asynchronous
on every path: the idle path runs it as a task that server shutdown waits for.
It can be awaited twice for one carrier (Clear while a message is being
cancelled) and has to tolerate that.

After the first two paths, and after a server restart, the side conversation
is still stored and its next message gets a new carrier. `durable` tells a
carrier that this can happen: the composer's Side chat is durable, a Canvas
comment thread is not. A carrier handles it in one of two ways:

- It keeps the provider's side resumable. It saves what the next carrier needs
  with `persist_state(value)`, any JSON value, and its `close()` leaves that
  usable at the provider. The server keeps the value with the side
  conversation and hands it to the next carrier as `persisted_state`, which
  takes the provider's side up again, or raises `SideQuestionError(410, ...)`
  when it is gone: a follow-up never continues silently from another context.
  The Codex carrier works this way. Its durable fork is a saved thread,
  `close()` ends only the fork's process, and the next carrier resumes the
  thread.
- It keeps nothing. The provider gets the earlier exchanges with every message
  (`lacks`, below), so `close()` removes everything. The Claude and Cursor
  carriers work this way.

A carrier that removes the provider's side in `close()` and relies on it for
the next message answers 410 after every idle period. Choose one of the two.

Clear discards the saved state, and the next message starts without any. The
carrier is closed as on every other path and is not told that the cause was
Clear. What a resumable carrier left at the provider therefore stays there
unused: after Clear, a saved Codex fork remains a thread in Codex's storage.

The server ends a side conversation with 410 by itself when the chat's backend
or `provider_id` is no longer what the binding holds, and when a stored side
conversation's binding, `provider_revision` included, differs at its next
carrier. A carrier's `check` adds its own reasons (Codex: another endpoint
credential, a configuration change in progress).

A Canvas comment thread uses the same carriers differently: every comment gets
a new carrier, not durable and without saved state, which is closed when the
comment is answered. The provider therefore sees the chat as it stands, and
nothing of a thread is kept on the provider's side.

### A message

`ask` is called for one message at a time per side conversation; the stores
refuse a second one while the first runs. `current()` and `check()` run before
every message and again after a question, so the answer to a question that
arrives after the chat changed is dropped. They do not run after an edit
request: the file is changed by then, and the reply is delivered whatever
became of the chat.

`history` is the side conversation so far, `[{"question", "response"}]`, at
most twenty exchanges. Providers differ in how they come to know it, and
`lacks(history, edit=...)` says which case applies:

- The provider keeps the side conversation (a fork the carrier made earlier or
  took up again): `lacks` is False, and the carrier ignores `history`.
- The carrier hands `history` to the provider (Claude's `/btw`): False.
- Neither: True. The caller then writes the exchanges into the question, in its
  own words (a side chat and a comment thread word them differently), oldest
  first and each earlier answer cut at 20,000 characters, and passes an empty
  `history`. A carrier never formats them itself.

`edit` is False for a question and True for an edit request, which only a
Canvas comment sends. The requirement, not the mechanism, is part of the
interface:

- A question can read the workspace's files and run commands that change
  nothing, and gives their output in its answer: a side chat is for looking
  things up beside the chat, so a carrier for a new backend provides both.
  Claude's `/btw` has no tools and answers from the conversation alone; that
  is its native limit, not the rule.
- A question never changes the chat's provider conversation. It does not
  change files on its own account. Whether an explicit request for a change in
  the composer's Side chat is carried out is the backend's native rule: Codex
  does it with the chat's permissions and approvals, Claude and Cursor cannot.
- An edit request changes files with the chat's own permissions.
- The carrier chooses the means: a read-only mode of the provider where there
  is one (Cursor's ask mode), an operation without tools (`/btw`), refusing
  every permission request, instructions.

`on_step`, when it is not None, is an async function that any carrier can call
with the run's tool calls and interim messages: `{"id", "kind", "title",
"status", "output"?}`, `kind` one of `command`, `file_change`, `tool`,
`web_search`, `message`, `status` one of `running`, `completed`, `failed`. A
step sent again under the same `id` replaces the earlier one. The composer's
Side chat shows the steps; a Canvas comment passes None.

Errors: `SideQuestionError(status, message)`. 409 means retry later, 410 that
the side conversation is over and the user has to Clear, 503 that the provider
did not answer. The apps show their own text per status. Any other exception
is reported as a failed message without its text, which can hold the prompt.

### Cancel

A message is cancelled by cancelling the task that awaits `ask`: Stop, Clear,
removal of the chat and server shutdown all do this. `ask` receives
`asyncio.CancelledError` at its current await. The carrier may await in its
handler, so a native cancel first and the end of a process after it both fit,
and then lets the cancellation continue. The caller waits until `ask` has
ended, then awaits `close()`. Because one message runs at a time, the
cancellation addresses exactly that request. There is no separate cancel
method: a second path beside task cancellation would have to agree with it.

A second cancellation can arrive while the carrier ends the first one's
process, for example Clear right after Stop. The carrier still has to wait for
the process to be gone before it removes what the process writes to.

### Approvals

Optional. A carrier whose runs can wait for an approval sets `approvals`. The
approval belongs to the side run alone: it is raised with the chat's id, shows
among the chat's pending approvals, and `current()` tells the carrier whether
the side conversation still owns it. The Codex carrier does this through the
Codex approval path. A Canvas comment bounds a carrier with `approvals` to one
hour, because an approval that nobody answers would otherwise hold the Canvas
file's edit order.

### Availability

`usable()` and `available()` answer different questions for different readers,
and neither implies the other.

`usable()` is read only for the capability list and is about the server.
Cursor's is false only where the last runtime check found no Cursor CLI. A
check that failed, a login that expired and a state that is not known yet
leave Cursor in the list, and the question itself reports the failure (503):
the apps need the capability to read, stop and clear a side chat they already
show, so a backend must not leave the list for a condition that passes.

`available(...)` is read only by a Canvas comment, before the comment is
accepted, and is about one chat and one message. When the answer is no, the
comment starts a turn in the chat.

Claude's conditions that hold for the whole server, the Agent SDK transport
among them, are in `available` and not in `usable`. The capability has always
listed Claude, also under the print transport, where the composer's Side chat
reports the failure when a question is asked; that list is unchanged.

The composer's Side chat reads neither per message. It answers 409 for a chat
without a `provider_id`, accepts any other question and reports what `ask`
raises.

### The carriers today

| | Codex | Claude | Cursor | Gemini |
| --- | --- | --- | --- | --- |
| Answers with | a fork of the thread: saved for a stored side conversation, ephemeral otherwise | `/btw`; an edit request in a fork made by the print CLI | one CLI run on a copy of the session | one CLI run on a copy of the session |
| `composer` | yes | yes | yes | no |
| `side_aware` | yes | yes | no | no |
| Keeps the conversation | yes, the fork | no, replays `history` | no | no |
| Steps | yes | no | no | no |
| `approvals` | yes | no | no | no |
| Edit request | the chat's sandbox and approval policy | full-access chats only | the chat's permission mode | the chat's permission mode |
| Environment of a question's process | without the chat's coordinates | none: `/btw` runs on the chat's connection | without the chat's coordinates | the chat's |
| Environment of an edit request's process | without the chat's coordinates | the chat's | the chat's | the chat's |

Not behind the interface yet: the side chat store finds the thread ids of
Codex forks, which are not offered as chats to import, by the name `codex` in
the saved state, and the approval path is Codex's own. `CopiedSessionSideChat`
runs the Cursor copy, the Gemini copy and the Claude fork in one class and
picks the command by the chat's backend; the Gemini part is one block of it.

### Copies of a session

A carrier that answers in a copy of the chat's provider session, made in the
provider's own storage, has two things to prevent: the provider's CLI makes
the copy a complete session, which Import Chat would offer as a chat, and a
server that ends during the run leaves the copy behind. The side chat store
keeps a record for both, in `side_chats.sqlite3`, reached as
`SIDE_QUESTIONS.synced.store`:

- `record_copy(backend, copy_id, cwd)` before the copy exists. `cwd` is the
  chat's directory, which a CLI needs to find a session.
- `forget_copy(backend, copy_id)` once nothing of the copy is left on disk.
- `provider_thread_ids()` returns the recorded copy ids of every backend
  together with the Codex fork ids. A backend's Import Chat listing leaves
  these ids out (`local_cursor_session_candidates`).
- `recorded_copies(backend)` returns `(copy_id, cwd)` for what is still
  recorded. At server start, `remove_leftover_cursor_copies` removes those of
  Cursor and forgets them; `lifespan` calls it after the sweep of orphaned
  provider processes.

All but `provider_thread_ids()` run on the event loop's thread, which owns the
store's connection. The Cursor branch of `CopiedSessionSideChat.ask` is the one
caller today. Another carrier that copies a session calls `record_copy` and
`forget_copy` with its own backend name, leaves the ids that
`provider_thread_ids()` returns out of its Import Chat listing, and adds the
removal of `recorded_copies(backend)` beside Cursor's at server start.

The removal at start deletes only ids that were recorded, each found by its
id (`cursor_history.session_directory`), never by a pattern in the provider's
storage. The copy that a rewind makes is not recorded: it becomes the chat's
session. Not covered: a copy whose `meta.json` was not written yet when the
server ended, that is, during the store backup and before the CLI started. It
is not a session for Import Chat and stays on disk. Also not covered: a second
server instance of the same user on the same machine reads its own record
only, as for Codex fork ids, so its Import Chat can offer this server's copy
while the copy exists.

### What a new carrier must know

What the interface does not do for a carrier, as the code stands:

- `available()` is not asked for the composer's Side chat. The apps get one
  list per server (`composer` and `usable()`) and no signal per chat; a chat
  that cannot be answered is reported by its first question.
- A second cancellation can interrupt the carrier's own cancel handler: Clear
  right after Stop cancels the task again while the handler awaits. A handler
  that has to finish, such as the end of a process before its files are
  removed, shields that wait and repeats it (`CopiedSessionSideChat.ask`).
- A new carrier can be made for a side conversation while the `close()` of its
  previous carrier still runs: after the idle period and after Clear the
  server does not wait for `close()` before it accepts the next message. A
  Canvas comment thread closes its carrier after every comment in this way.
- `close()` is not told its cause. It cannot tell Clear from the idle period
  or from shutdown.
- "One message at a time" holds per side conversation, not per chat. A chat's
  composer Side chat and each of its Canvas comment threads are side
  conversations of their own, so several carriers of one chat run at the same
  time, and beside a turn of the chat.
- The last branch of `CopiedSessionSideChat.ask` runs the Cursor CLI for every
  backend that is not Claude or Gemini. A new backend does not reach it,
  because it has its own carrier class.
- Backends are still named in three places outside the map: the side chat
  store reads Codex fork ids under the name `codex`; in the desktop app,
  `SideChatPopover.tsx` keeps the Side chat button on Codex and Claude chats
  when the server lists neither; and the locale text that describes the side
  chat names Codex, Claude and Cursor.

## Canvas comment threads

A comment on a Canvas element, a question or an edit request, is answered in a
side chat of its comment thread. These side chats have their own store, keyed
by the thread, and the chat itself gets no turn. Every comment is answered by
a new copy of the chat as it stands. Nothing is kept on the provider's side
between a thread's comments: Claude's side question replays the thread's
earlier exchanges natively, and the others receive them with the comment.
Deleting the thread stops its running answer.
The answer comes from the carrier of the chat's backend, see "Carriers" above.

An edit request changes the Canvas file and runs the canvas check; its short
summary is the thread's reply. The chat's own conversation does not record the
edit.

What runs at the same time:

- The questions of one chat run in parallel, with each other and with a turn
  of the chat. A thread takes one comment at a time.
- The edit requests on one Canvas run one after another; edit requests on
  different Canvases run in parallel. Without this order, two copies that
  changed one Canvas file at the same time both reported their change, and
  the file held only one.
- Known limit: an edit in a side chat and a turn of the chat can both write
  the same Canvas file at the same time. Nothing orders them.
- A rewind restores the Canvas of the turn that is kept, including when a side
  chat changed the file after that turn.

Per provider:

- Codex: an ephemeral native fork for both kinds of comment, with the chat's
  approval policy and sandbox. An approval that the chat's settings require
  appears among the chat's pending approvals and is answered there. The
  comment waits for it up to an hour; while an edit request waits, the Canvas's
  later edit requests wait behind it.
- Claude: a question is a native side question, which has no tools. An edit
  request runs in a side chat when the chat has full access, which is the
  default. The Claude CLI then forks the session for one run with full access,
  keeps the fork in memory and writes no transcript of it; the chat's process
  and transcript are only read. In any other permission mode, or with a CLI
  that cannot keep the fork in memory, the edit request starts a turn in the
  chat.
- Gemini and Cursor: a copy of the native session that the CLI resumes and
  that is deleted once its answer returns. A question's copy has no write
  tools. An edit request's copy has the chat's permissions. In a mode that
  needs approval, nobody can approve in the copy: the edit is not applied, and
  the reply says so if the CLI says so.

The side chat store hands a comment to its side chat as text only, so the
comment's mode is read from the first line of its prompt. The server builds
that line; the lines after it hold the element's HTML as the client sent it.

The server announces each change of a thread with a `canvas_comments_updated`
packet on the chat's stream, including the end of an answer. On it the
desktop reads the threads again and lists the canvases to reload one whose
revision changed: that is how an edit shows without a turn. The mobile app
reads the threads only.

A comment starts a turn in the chat when the client does not send
`side_chat`, the chat has no native conversation yet, the backend is
OpenCode, Claude cannot take the comment as a side question (print transport,
or a comment above the side question limit), or, for an edit request, the
Claude conditions above are not met.
