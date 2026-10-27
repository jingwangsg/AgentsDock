// The terminal page's font. Android's web view draws the system monospace font, which Android 15 maps to
// Droid Sans Mono (/system/etc/font_fallback.xml); iOS bundles that file (terminalFont.ios.ts).
export const TERMINAL_FONT_FAMILY = 'monospace'
/** CSS that defines TERMINAL_FONT_FAMILY in the page; empty where the system has it. */
export const TERMINAL_FONT_FACE = ''
