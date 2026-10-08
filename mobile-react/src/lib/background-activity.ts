/** What keeps running for a chat outside its turn: a Codex background terminal, or a shell Claude runs in the background (`command` is then its description). */
export interface BackgroundActivityItem {
  id: string
  command: string
}
