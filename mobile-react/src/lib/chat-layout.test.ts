import { chatWorkspaceLayout, sidebarWidth } from './chat-layout'

function assertLayout(width: number, height: number, compact: boolean, inlineInspectorAvailable: boolean, message: string): void {
  const layout = chatWorkspaceLayout(width, height)
  if (layout.compact !== compact || layout.inlineInspectorAvailable !== inlineInspectorAvailable) {
    throw new Error(`${message}: expected ${JSON.stringify({ compact, inlineInspectorAvailable })}, received ${JSON.stringify(layout)}`)
  }
}

assertLayout(599, 1024, true, false, '599pt remains compact without inline inspector')
assertLayout(600, 1024, false, false, '600pt (medium width class) uses the chat/details sheet path')
assertLayout(701, 841, false, false, 'unfolded Pixel Fold portrait gets two panes')
assertLayout(841, 701, false, false, 'unfolded Pixel Fold landscape gets two panes')
assertLayout(411, 797, true, false, 'Pixel Fold cover screen stays compact')
assertLayout(353, 904, true, false, 'Galaxy Fold cover screen stays compact')
assertLayout(996, 407, true, false, 'unfolded clamshell (Flip) landscape stays compact')
assertLayout(1079, 1366, false, false, '1079pt cannot mount the inline inspector')
assertLayout(1080, 1366, false, true, '1080pt can mount the inline inspector')
assertLayout(1180, 590, true, false, 'wide but short viewports remain compact')

function assertSidebarWidth(width: number, collapsed: boolean, expected: number): void {
  const actual = sidebarWidth(width, collapsed)
  if (actual !== expected) throw new Error(`sidebarWidth(${width}, ${collapsed}): expected ${expected}, received ${actual}`)
}

assertSidebarWidth(700, false, 240)
assertSidebarWidth(760, false, 255)
assertSidebarWidth(1180, false, 285)
assertSidebarWidth(700, true, 0)
assertSidebarWidth(1180, true, 0)

console.log('chat layout breakpoint regressions passed')
