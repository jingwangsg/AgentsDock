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
- Claude: native `side_question` control (the `/btw` operation) on the exact
  chat-owned SDK connection. Only connection acquisition is actor-serialized;
  waiting for a side answer never occupies the main-turn actor. Cancellation
  addresses only its control request. Cold connections must resume the exact
  parent identity; an empty conversation is not an acceptable fallback.
  A connected parent keeps its current settings for side questions, even if
  saved model or effort settings have changed for the next main turn.
- Cursor: the CLI has no side chat and no fork. Every question runs the CLI
  once on a new copy of the chat's native session as it stands, in the CLI's
  ask mode and on the chat's model. The copy and what the run leaves are
  deleted when the answer returns, and also when the question is cancelled or
  fails. Nothing is kept on the provider's side between questions, so the
  server puts the side chat's earlier exchanges in front of the question. In
  front of those it puts one sentence that says that this is a question in a
  read-only side chat: the CLI resumes the copy as the chat itself and does not
  know otherwise. Measured without the sentence: a follow-up was answered from
  the chat's own last reply, and a request for a change with "switch to Agent
  mode". The chat's own session is only read, and it can be in the middle of
  a turn. The same copy mechanism answers Canvas comments, see below.

  Ask mode is the CLI's read-only mode. Measured with CLI 2026.11.22: the agent
  reads and searches files and runs shell commands that only read (`ls`, `ps`);
  asked to edit a file or to run a command that writes, it answers that the
  mode does not allow it and makes no tool call. The mode's restriction is
  therefore the CLI's, not one this server enforces. A side question raises no
  approval request, and its steps are not reported.

The desktop requires `side_questions.version: 2` and `native_context: true`.
`side_questions.backends` lists the backends this server answers for, and the
clients offer Side chat for those. The list comes from the carriers, see
"Carriers" below. Cursor is listed while its CLI is usable: the last runtime
check found it ready, or no check has run since the server started. Each
request supplies `request_id`, `side_chat_id`, `question`, and,
for a follow-up, `after_request_id`. The server deduplicates receipts and
verifies the predecessor before asking the provider. Client-authored history is
refused. Claude receives its native maximum of twenty server-owned side
exchanges, and a Cursor question carries the same twenty; Codex retains its own
ephemeral transcript. No parent text budget is applied.
Codex captures the main context on its first question; Clear starts a new fork
with the latest main context. Its workspace tools can inspect current files
even when the inherited conversation predates those files. A Cursor question
sees the chat as it stands when the question is sent, so a follow-up also sees
what the chat did in between; Clear removes the side chat's exchanges.

`DELETE /api/sessions/{session}/side-questions/{request}` cancels one request.
`DELETE /api/sessions/{session}/side-chats/{side_chat}` closes the side chat.
Both are native-operator-only and scoped to the authenticated owner and parent.
Clear, profile shutdown and server shutdown release owned resources. Idle side
contexts expire after thirty minutes without polling; stale follow-ups receive
410 rather than silently starting with different context. Cancellation/error
also closes the side conversation; the user can Clear to start again.
A Cursor side chat holds nothing between questions, so these events have
nothing of it to release; a question that is running is stopped, and its copy
is deleted. A Cursor side chat also gets 410 once the chat's native session is
another one than at its first question.

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
maps a chat's backend to its carrier class, and it is the only place that names
backends for side conversations. Everything else reads what the carrier says:

- `health` lists a backend in `side_questions.backends` while its carrier has
  `composer` and `usable()` is true. The apps offer Side chat for that list.
- `create_native_side_chat` binds a side conversation to the chat and makes its
  carrier. The side chat stores call it for the composer.
- `create_canvas_comment_side_chat` and `canvas_comment_side_chat_available`
  do the same for a comment thread.

A new backend implements the class and adds one entry to the map. It does not
touch the routes, the stores, the Canvas code or the apps. The interface does
not assume a CLI, a process or a copied session.

### What a carrier provides

Class level, asked without an instance:

| Member | Meaning |
| --- | --- |
| `composer` | True: answers the composer's Side chat. False: Canvas comment threads only. |
| `native` | True: the provider knows that it answers beside the chat (a native side question, a fork that the carrier instructs). False: the provider is the chat's own CLI on a copy; the composer then says in the question that it is a read-only side question. |
| `approvals` | True: a run can wait for an approval. Optional, see below. |
| `usable()` | Whether this server can run the backend at all, from server state such as the runtime check. |
| `provider_id(session)` | The id of the chat's provider conversation, empty before it exists. |
| `provider_revision(session)` | What else must stay as it is for a side conversation to go on (Codex: the credential of a custom endpoint). Default: nothing. |
| `available(session, question, edit=...)` | Whether this server can answer this message for this chat now: the chat has a provider conversation, it is on this server, the runtime allows it, the mode is supported. Asked per mode. |

Instance level, for one side conversation:

| Member | Meaning |
| --- | --- |
| `ask(question, history=..., edit=False, on_step=None)` | Answers one message and returns `{"answer", "context_note"}`. |
| `lacks(history, edit=False)` | Whether the provider would answer the next message without these earlier exchanges. |
| `check(session)` | Raises `SideQuestionError` when the carrier cannot go on for the chat as it is now. Optional. |
| `close()` | Releases everything the carrier holds. |

The constructor is the base class's. It gives the carrier `session_id`,
`binding` (`backend`, `parent_id`, `provider_revision` of the chat at the first
message), `current()` (the chat's session now; it raises once the side
conversation is over), `durable`, `saved_state` and `save_state(value)`.

### State and lifetime

A carrier belongs to one side conversation, not to one request. The server
makes it at the conversation's first message, for the chat's provider
conversation as it is then, keeps it for the follow-ups, and awaits `close()`
when the conversation ends. So a carrier can create a fork or a native side
conversation at its first `ask`, continue it at the next, and remove it in
`close()`.

The conversation ends, and `close()` is awaited, on: Clear; thirty minutes
without a message; a message that failed or was cancelled; removal of the chat;
server shutdown. `close()` is asynchronous on every one of these paths: the
idle path runs it as a task that server shutdown waits for. It can be awaited
twice for one carrier (Clear while a message is being cancelled) and has to
tolerate that.

A side conversation of the composer outlives its carrier: it is stored on the
server, and its next message can come after an idle close, after a stopped
message or after a server restart. `durable` tells the carrier so. A durable
carrier saves what a later carrier needs with `save_state(value)`, any JSON
value; the server keeps it with the side conversation and hands it to the next
carrier as `saved_state`. That carrier takes the provider's side conversation
up again, or raises `SideQuestionError(410, ...)` when it is gone: a follow-up
never continues silently from another context. Clear discards the saved state.

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
and after it, so an answer that arrives after the chat changed is dropped.

`history` is the side conversation so far, `[{"question", "response"}]`, at
most twenty exchanges. Providers differ in how they come to know it, and
`lacks(history, edit=...)` says which case applies:

- The provider keeps the side conversation (a fork the carrier made earlier or
  took up again): `lacks` is False, and the carrier ignores `history`.
- The carrier hands `history` to the provider (Claude's `/btw`): False.
- Neither: True. The caller then writes the exchanges into the question, in its
  own words (a side chat and a comment thread word them differently), and
  passes an empty `history`. A carrier never formats them itself.

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
- How a carrier keeps to this is its own business: a read-only mode of the
  provider where there is one (Cursor's ask mode), a tool-less operation
  (`/btw`), refusing every permission request, instructions.

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

### Approvals

Optional. A carrier whose runs can wait for an approval sets `approvals`. The
approval belongs to the side run alone: it is raised with the chat's id, shows
among the chat's pending approvals, and `current()` tells the carrier whether
the side conversation still owns it. The Codex carrier does this through the
Codex approval path; a second backend raises its requests in the same registry.
A Canvas comment bounds a carrier with `approvals` to one hour, because an
approval that nobody answers would otherwise hold the Canvas file's edit order.

### Availability

Three questions, each answered by the carrier:

- Can this server run the backend? `usable()`. It decides the capability list.
- Does the chat have a provider conversation to answer from? `provider_id`.
  The composer's Side chat answers 409 without one.
- Can this message be answered for this chat now, in this mode?
  `available(session, question, edit=...)`. A Canvas comment asks it before it
  is accepted, and starts a turn in the chat when the answer is no. The
  composer's Side chat accepts a question and reports what `ask` raises.

### The carriers today

| | Codex | Claude | Cursor | Gemini |
| --- | --- | --- | --- | --- |
| Answers with | an ephemeral fork | `/btw`; an edit request in a fork made by the print CLI | one CLI run on a copy of the session | one CLI run on a copy of the session |
| `composer` | yes | yes | yes | no |
| `native` | yes | yes | no | no |
| Keeps the conversation | yes, the fork | no, replays `history` | no | no |
| Steps | yes | no | no | no |
| `approvals` | yes | no | no | no |
| Edit request | the chat's sandbox and approval policy | full-access chats only | the chat's permission mode | the chat's permission mode |

Not behind the interface yet: the side chat store records the thread ids of
Codex forks so that they are not offered as chats to import, and the approval
path is Codex's own. `CopiedSessionSideChat` runs the Cursor copy, the Gemini
copy and the Claude fork in one class and picks the command by the chat's
backend; the Gemini part is one block of it.

## Canvas comment threads

A comment on a Canvas element, a question or an edit request, is answered in a
side chat of its comment thread, by the carrier of the chat's backend (see
"Carriers" above). These side chats have their own store, keyed
by the thread, and the chat itself gets no turn. Every comment is answered by
a new copy of the chat as it stands. Nothing is kept on the provider's side
between a thread's comments: Claude's side question replays the thread's
earlier exchanges natively, and the others receive them with the comment.
Deleting the thread stops its running answer.

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
