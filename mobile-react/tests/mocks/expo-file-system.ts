export class File {
  constructor(readonly uri: string) {}

  // Opt-in failure hook: a URI carrying the "#unreadable" fragment models an
  // iOS photo whose bytes cannot be materialized (iCloud not downloaded,
  // limited-library, or a File provider). It never affects other fixtures.
  get exists(): boolean { return !this.uri.includes('#unreadable') }
}
