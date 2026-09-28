// Port of electron/src/renderer/src/lib/timeline-labels.ts (English only).

const eventLabels: Record<string, string> = {
  session_created: 'Session Created', session_updated: 'Session Updated',
  session_resumed: 'Session Resumed', session_imported: 'Session Imported',
  user_message: 'User Message', assistant_message: 'Assistant Message',
  turn_started: 'Turn Started', turn_finished: 'Turn Finished', turn_stopped: 'Turn Stopped',
  tool_started: 'Tool Started', tool_finished: 'Tool Finished', error: 'Error',
  reasoning_summary: 'Reasoning Summary', system: 'System', system_message: 'System Message',
  working_directory_changed: 'Working Directory Changed',
  provider_session_reset: 'Provider context reset',
  handoff_digest_received: 'Handoff Digest Received', handoff_digest_sent: 'Handoff Digest Sent',
  handoff_digest_error: 'Handoff Digest Error', handoff_digest_started: 'Handoff Digest Started',
}

export function titleCase(value: string): string {
  return value.split(/[_\s]+/).filter(Boolean).map(word => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ')
}

/** Only known semantic event types are mapped; arbitrary provider content is never a key. */
export function timelineEventLabel(type: string): string {
  return Object.hasOwn(eventLabels, type) ? eventLabels[type] : titleCase(type)
}
