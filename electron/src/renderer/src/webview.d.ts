import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  /** The <webview> tag as the browser tab drives it: the subset of Electron's WebviewTag it calls. */
  interface WebviewElement extends HTMLElement {
    loadURL(url: string): Promise<void>
    reload(): void
    stop(): void
    goBack(): void
    goForward(): void
    canGoBack(): boolean
    canGoForward(): boolean
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<WebviewElement> & { src?: string; partition?: string }, WebviewElement>
    }
  }
}
