// Android draws menus and alerts natively and needs no overlay host (see the .ios.tsx file).
// This file also keeps MaterialOverlay and materialTheme (whose require()s bundle the fonts) out of the Android bundle.
export function MaterialOverlayHost() { return null }
