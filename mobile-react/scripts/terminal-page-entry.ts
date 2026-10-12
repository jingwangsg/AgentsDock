// The Android terminal web view's script, moved out of the HTML template in
// src/components/terminal/TerminalViewport.android.tsx and bundled with xterm.js by scripts/embed-xterm.mjs.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const config = window.__agentsDockTerminalConfig;
const post = value => window.ReactNativeWebView?.postMessage(JSON.stringify(value));
const host = document.getElementById('terminal');
const term = new Terminal({
  cursorBlink: true,
  fontFamily: config.fontFamily,
  fontSize: config.fontSize,
  scrollback: 10000,
  allowProposedApi: true,
  theme: { background: config.backgroundHex, foreground: config.foregroundHex, cursor: config.cursorHex, cursorAccent: config.backgroundHex, selectionBackground: config.selectionHex }
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(host);
fit.fit();
let socket = null;
let reconnectTimer = null;
let disposed = false;
let opened = false;
const focus = () => { term.focus(); term.textarea?.focus({ preventScroll: true }); };
const visibleText = () => {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + term.rows);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').replace(/\s+$/, '');
};
const sendSize = () => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', columns: term.cols, rows: term.rows }));
};
// The server reads typed input only from binary frames; a text frame is a JSON
// control message and anything else is dropped (so was every keystroke, and
// xterm's own answer to the shell's Primary Device Attributes query).
const encoder = new TextEncoder();
const sendInput = text => { if (text && socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(text)); };
const modifiers = { ctrl: false, alt: false };
const reportModifiers = () => post({ type: 'modifiers', ctrl: modifiers.ctrl, alt: modifiers.alt });
const releaseModifiers = () => { modifiers.ctrl = false; modifiers.alt = false; reportModifiers(); };
// A sticky Ctrl/Alt from the key row applies to the next single character, then releases.
const withModifiers = text => {
  if (text.length !== 1 || (!modifiers.ctrl && !modifiers.alt)) return text;
  const ctrl = modifiers.ctrl, alt = modifiers.alt;
  releaseModifiers();
  let out = text;
  if (ctrl) {
    const code = text.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code & 0x1f);
    else if (text === ' ') out = '\x00';
  }
  return alt ? '\x1b' + out : out;
};
const cursorKey = letter => {
  if (modifiers.ctrl || modifiers.alt) {
    const parameter = modifiers.ctrl && modifiers.alt ? '7' : modifiers.ctrl ? '5' : '3';
    releaseModifiers();
    return '\x1b[1;' + parameter + letter;
  }
  return (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + letter;
};
const KEY_TEXT = { escape: '\x1b', tab: '\t', enter: '\r', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', dash: '-', slash: '/', pipe: '|', tilde: '~' };
const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };
const key = name => {
  focus();
  if (ARROWS[name]) return sendInput(cursorKey(ARROWS[name]));
  const text = KEY_TEXT[name];
  if (text != null) sendInput(withModifiers(text));
};
const connect = () => {
  if (disposed) return;
  post({ type: 'status', status: opened ? 'Reconnecting' : 'Connecting' });
  socket = new WebSocket(config.socketURL);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => { opened = true; fit.fit(); sendSize(); };
  socket.onmessage = event => {
    if (typeof event.data === 'string') {
      try {
        const control = JSON.parse(event.data);
        if (control.type === 'ready') {
          post({ type: 'status', status: 'Connected', name: control.name, message: control.message });
          return;
        }
      } catch {}
      term.write(event.data);
    } else {
      term.write(new Uint8Array(event.data));
    }
  };
  socket.onerror = () => post({ type: 'status', status: 'Error', message: 'Terminal connection failed.' });
  socket.onclose = () => {
    if (disposed) return;
    post({ type: 'status', status: 'Reconnecting' });
    reconnectTimer = setTimeout(connect, 800);
  };
};
term.onData(data => sendInput(withModifiers(data)));
term.onResize(sendSize);
window.__agentsDockTerminal = {
  focus,
  blur: () => term.blur(),
  paste: text => { focus(); term.paste(String(text ?? '')); },
  copy: requestId => post({ type: 'copy', requestId, text: term.getSelection() || visibleText() }),
  key,
  modifier: (name, active) => { if (name in modifiers) { modifiers[name] = !!active; reportModifiers(); } }
};
host.addEventListener('pointerdown', focus);
host.addEventListener('touchstart', () => requestAnimationFrame(focus), { passive: true });
new ResizeObserver(() => { fit.fit(); sendSize(); }).observe(document.body);
window.addEventListener('beforeunload', () => {
  disposed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  term.dispose();
});
connect();
