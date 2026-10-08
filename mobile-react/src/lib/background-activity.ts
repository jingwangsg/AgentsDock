/** What keeps running for a chat outside its turn: a Codex background terminal, or an agent or shell Claude still tracks (`command` is then its description). */
export interface BackgroundActivityItem {
  id: string
  command: string
}
