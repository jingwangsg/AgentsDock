/**
 * Build-time switch for the Team Network entry points on the phone: the sidebar
 * button, the Team Network sheet, the `@@` recipient picker and the mail command.
 *
 * Mirrors electron/src/renderer/src/lib/team-network-ui.ts. Set
 * `EXPO_PUBLIC_AGENTSDOCK_TEAM_NETWORK_UI=0` when bundling to hide them; the
 * server keeps advertising and serving the capability. Unset (upstream builds)
 * leaves them enabled, and the node test runner always sees them enabled so the
 * suite keeps documenting the full UI even under android-env.sh.
 */
export const TEAM_NETWORK_UI_ENABLED = process.env.NODE_TEST_CONTEXT
  ? true
  : process.env.EXPO_PUBLIC_AGENTSDOCK_TEAM_NETWORK_UI !== '0'
