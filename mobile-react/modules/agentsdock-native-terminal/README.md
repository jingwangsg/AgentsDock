# AgentsDock Native Terminal

iOS app delegate subscriber that ends text editing in every window when the app
leaves the foreground, and once more after it returns, so UIKit cannot restore
a first responder and its keyboard. It covers React Native inputs and web views,
including the terminal.

The terminal itself is the shared xterm.js web view
(`src/components/terminal/TerminalViewport.native.tsx`). The package and pod keep
the names they had when they also held the SwiftTerm terminal view; the Expo
config now registers only the app delegate subscriber.
