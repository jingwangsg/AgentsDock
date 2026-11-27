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

The desktop requires `side_questions.version: 2` and `native_context: true`.
Each request supplies `request_id`, `side_chat_id`, `question`, and, for a
follow-up, `after_request_id`. The server deduplicates receipts and verifies
the predecessor before asking the provider. Client-authored history is refused.
Claude receives its native maximum of twenty server-owned side exchanges;
Codex retains its own ephemeral transcript. No parent text budget is applied.
Codex captures the main context on its first question; Clear starts a new fork
with the latest main context. Its workspace tools can inspect current files
even when the inherited conversation predates those files.

`DELETE /api/sessions/{session}/side-questions/{request}` cancels one request.
`DELETE /api/sessions/{session}/side-chats/{side_chat}` closes the side chat.
Both are native-operator-only and scoped to the authenticated owner and parent.
Clear, profile shutdown and server shutdown release owned resources. Idle side
contexts expire after thirty minutes without polling; stale follow-ups receive
410 rather than silently starting with different context. Cancellation/error
also closes the side conversation; the user can Clear to start again.

Tests must cover real tool-result context, successive questions, cancellation
with a running parent, unchanged parent goals/transcripts, native cold resume,
HTTP ownership, request deduplication and Clear arriving before a delayed POST.
Never import the production server or use a real user chat in test setup.

## Canvas comment threads

A comment on a Canvas element, a question or an edit request, is answered in a
side chat of its comment thread. These side chats have their own store, keyed
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
