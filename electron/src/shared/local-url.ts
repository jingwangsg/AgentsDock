/**
 * Explicit-port HTTP loopback URLs (localhost, 127.x.x.x, 0.0.0.0, [::1]).
 * Lives in shared so both the renderer's terminal port detection and the
 * main-process chat outputs collector match the same shape.
 */
export const LOCAL_URL_PATTERN = /http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))(?=[/?#\s)'"\]}>,]|$)[^\s)'"\]}>,]*/gi
