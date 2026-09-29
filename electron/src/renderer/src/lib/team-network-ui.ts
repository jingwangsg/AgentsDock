/**
 * Build-time switch for the Team Network entry points: the sidebar button, the
 * Team Network pane, `@@` recipient mentions and the `/mail` command.
 *
 * Hidden by default; set `VITE_AGENTSDOCK_TEAM_NETWORK_UI=1` when building to
 * show them. The server keeps advertising and serving the capability either
 * way; only the desktop UI stops exposing it.
 *
 * Tests always see it enabled: the suite documents the full UI, and the build
 * script runs vitest in the same environment it later builds with.
 */
export const TEAM_NETWORK_UI_ENABLED = import.meta.env.VITEST
  ? true
  : import.meta.env.VITE_AGENTSDOCK_TEAM_NETWORK_UI === '1'
