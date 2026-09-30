import { ServerError } from '../api/AgentServerClient'
import type { Health } from '../types'
import { parseSyncedSideChat, sideChatAvailable, sideChatErrorMessage, sideChatLimit } from './side-chat'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const capability = { available: true, version: 2, native_context: true, sync: true, backends: ['codex', 'claude'], max_question_chars: 4000 }
const health = (sideQuestions: object) => ({ ok: true, capabilities: { side_questions: sideQuestions } }) as unknown as Health

assert(sideChatAvailable(health(capability), 'codex') && sideChatAvailable(health(capability), 'claude'), 'Codex and Claude chats get side chat')
assert(!sideChatAvailable(health(capability), 'cursor'), 'Cursor chats do not')
assert(!sideChatAvailable(health({ ...capability, sync: false }), 'codex'), 'a server without synced side chat does not')
assert(!sideChatAvailable(null, 'codex'), 'no health, no side chat')
assert(sideChatLimit(health(capability)) === 4000 && sideChatLimit(null) === 8000, 'the server limit applies, capped at 8000')

const chat = { session_id: 'chat', side_chat_id: 'side', revision: 3, last_request_id: null, exchanges: [] }
assert(parseSyncedSideChat(chat, 'chat') === chat, 'a snapshot for this chat is accepted')
let rejected = false
try { parseSyncedSideChat(chat, 'other') } catch { rejected = true }
assert(rejected, "another chat's snapshot is rejected")

// Request failures carry an HTTP status; failed exchanges carry the server's code.
assert(/maximum number of side questions/.test(sideChatErrorMessage(new ServerError(429, 'busy'))), 'a 429 reads as busy')
assert(/not authorized/.test(sideChatErrorMessage(new ServerError(403, 'forbidden'))), 'a 403 reads as unauthorized')
assert(/interrupted when the server restarted/.test(sideChatErrorMessage('side_question_interrupted')), 'an interrupted exchange says so')
assert(/timed out/.test(sideChatErrorMessage('side_question_http_504')), 'a 504 exchange reads as a timeout')
assert(/could not be answered/.test(sideChatErrorMessage('side_question_failed')), 'anything else is the generic failure')
console.log('side chat regressions passed')
