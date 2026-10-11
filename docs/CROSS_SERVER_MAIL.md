# Cross-server chat mail

It extends the same-server passive mailbox (`async_route_v1`, see
[CROSS_CHAT_HANDOFFS_PLAN.md](CROSS_CHAT_HANDOFFS_PLAN.md)) to chats on the
remote servers a hub manages.

## Product contract

- The `@` picker lists chats on every live server under the active server's
  hub: the hub itself and each remote that answers and supports
  `cross_server_mail_v1`. An unreachable server is left out.
- Each row carries its server name as a tag. Chats on the hub carry none.
- Ranking: a title match first, ranked as the sidebar search ranks it
  (exact, prefix, word start, substring); then chats where every
  space-separated term matches the title, folder or server name as
  characters in order (`fuzzyScore`, a title match counting double); then
  chats matching what the sidebar search also covers (backend, model, folder
  path, ids) or a pasted remote chat id.
- The other servers' chats arrive after the list opens. With the query
  unchanged, the highlighted chat stays highlighted when they do.
- Choosing a chat on another server inserts `@<title> · <server>` (no server
  for a hub chat). On send, the client asks the hub to pair the two chats, then
  sends the turn without that reference; the chip stays in the prompt text.
- The paired chats exchange mail with the existing helper commands (`chats
  list`, `send --route`, `inbox`, `read`, `send --reply-to`). A message from
  another server is an ordinary mailbox message on the receiving server: idle
  wake, the running-turn hint, read receipts and the timeline cards are the
  same.

## Authority

- Only the hub creates pairs, from an authenticated client request, and only
  the hub moves mail. A remote never calls the hub.
- The hub relays an item only when its own pair registry links exactly the
  item's source and target. The source server is the end the hub read the
  item from, never a field of the item, so a remote cannot send to a chat it
  was not paired with. A remote that reports the hub's or another server's
  identity is not relayed to or from.
- The receiving server checks its own half of the pair before storing.
- User delegation: the chip never reaches the sender's server, so its text
  stands in for the admission-checked span a local `@Chat` chip carries. When
  the sender's turn is the user's own and contains the paired chat's chip
  (`@<title> · <server>`, or `@<title>` for a hub chat) as a whole token, the
  sender's server attaches the user's instruction. If the turn also holds a
  longer matching chip of another paired chat ("@Launch check" against a
  peer titled "Launch"), only the longer one delegates. A hub peer titled
  "Launch" still matches "@Launch check" when that chat is not paired. The
  receiving server stores the instruction as that peer's attestation, so a hub
  trusts its registered remotes to attest their users' turns.

## Wire

Server-to-server, with the remote's own token through the hub's tunnel:

```text
GET    /api/admin/cross-server/outbox?wait=S      due items; long poll up to 55 s
POST   /api/admin/cross-server/outbox/{id}/result delivered | failed | pending (retry_after)
POST   /api/admin/cross-server/inbox              store mail from a paired chat
POST   /api/admin/cross-server/receipts           a sent message was read
GET    /api/admin/cross-server/sessions/{id}      title/backend, for pairing
POST   /api/admin/cross-server/routes             install (or refresh) this server's half
DELETE /api/admin/cross-server/pairs/{pair_id}    remove this server's halves
```

Client-facing, on the hub:

```text
GET    /api/cross-server/chats                    live servers and their chats
POST   /api/cross-server/chats                    create a chat on one of them (the composer's "Create new agent")
POST   /api/cross-server/pairs                    pair two chats (idempotent); `target_label` is the chip's title part
GET    /api/cross-server/pairs?server_identity=&session_id=
DELETE /api/cross-server/pairs/{pair_id}
```

A client whose profile is `<hub>/api/remote/<id>` calls `<hub>/api/cross-server/…`
with that profile's token (the hub token); any other server is its own hub.

## Delivery

- Each server keeps `cross_server_routes` (its halves) and
  `cross_server_outbox` (sent mail and read receipts) in the cross-chat ledger;
  the hub also keeps `cross_server_pairs`.
- The hub runs one pump per server: its own outbox wakes on an in-process
  event, each remote's on a long poll over the existing tunnel. A server's own
  pump takes only mail of pairs it created; the rest waits for its hub.
- Request paths (the chat list, pairing) use the remotes the relay last found
  reachable and never probe; the relay probes the registry every 30 s.
- An unreachable target is retried with backoff (15 s doubling, at most 10
  min) and fails after 24 hours; the rest of that batch for the same target
  waits without a call. When the receiving server refuses the item (it has no
  half of that pair, or the chat is gone) the item fails at once. Removing a
  pair fails its undelivered mail. A failure shows on the sender's timeline.
- An item whose pair is not in this hub's registry is rescheduled every 5
  minutes, not failed, so a remote attached to two hubs is drained by the hub
  that paired it; it fails after 24 hours.
- Peer mail ends a Claude run that only waits on background tasks only when its
  mailbox wake can start right after (not after Stop, for a removed pair, or
  behind an update).

## Not covered

- No UI lists or removes cross-server pairs yet; `DELETE
  /api/cross-server/pairs/{pair_id}` does. A server unreachable at removal
  keeps its half; its mail is then rescheduled until it fails after 24 hours.
- Delegation is attached only on the user's own turn, never on a steer, a
  scheduled job or a relayed turn.
