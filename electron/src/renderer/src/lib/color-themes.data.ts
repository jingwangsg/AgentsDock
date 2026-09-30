// Palettes transcribed from each theme's pinned upstream source (see `source`). Colors only; no upstream code.
import type { EditorThemePalette } from './editor-appearance'

export type ColorThemeUiToken = 'bg' | 'surface' | 'surface-2' | 'surface-3' | 'border' | 'border-soft' | 'border-focused'
  | 'text' | 'muted' | 'faint' | 'accent' | 'accent-hover' | 'text-on-accent'
  | 'green' | 'green-surface' | 'green-border' | 'amber' | 'amber-surface'
  | 'danger' | 'danger-surface' | 'danger-strong' | 'danger-highlight' | 'danger-text'

export interface ColorThemeTerminal {
  background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}

export interface ColorThemeData {
  id: string          // kebab-case, e.g. 'catppuccin-mocha'
  label: string       // display name exactly as upstream names it, e.g. 'Catppuccin Mocha'
  mode: 'light' | 'dark'
  source: { url: string; license: string; copyright: string }  // url pinned to a commit SHA or release tag; license SPDX id; copyright line from the upstream LICENSE
  ui: Record<ColorThemeUiToken, string>
  terminal: ColorThemeTerminal
  editor: EditorThemePalette
}

export const COLOR_THEMES: readonly ColorThemeData[] = [
  {
    id: 'ayu-dark',
    label: 'Ayu Dark',
    mode: 'dark',
    source: { url: 'https://github.com/zed-industries/zed/blob/a3f6ef252b6de19d22a1223952fc335253163642/assets/themes/ayu/ayu.json', license: 'MIT', copyright: 'Copyright (c) 2016 Ike Ku' },
    ui: {
      bg: '#0d1016', surface: '#1f2127', 'surface-2': '#2d2f34', 'surface-3': '#3e4043', border: '#3f4043', 'border-soft': '#2d2f34', 'border-focused': '#1b4a6e',
      text: '#bfbdb6', muted: '#8a8986', faint: '#696a6a', accent: '#5ac1fe', 'accent-hover': '#73cafe', 'text-on-accent': '#0d1016',
      green: '#aad84c', 'green-surface': '#294113', 'green-border': '#405c1c', amber: '#feb454', 'amber-surface': '#572815',
      danger: '#ef7177', 'danger-surface': '#48161b', 'danger-strong': '#d26369', 'danger-highlight': '#e16a70', 'danger-text': '#f49ba0'
    },
    terminal: {
      background: '#0d1016', foreground: '#bfbdb6', cursor: '#5ac1fe', cursorAccent: '#0d1016', selectionBackground: '#5ac1fe3d',
      black: '#0d1016', red: '#ef7177', green: '#aad84c', yellow: '#feb454', blue: '#5ac1fe', magenta: '#39bae5', cyan: '#95e5cb', white: '#bfbdb6',
      brightBlack: '#545557', brightRed: '#83353b', brightGreen: '#567627', brightYellow: '#92582b', brightBlue: '#27618c', brightMagenta: '#205a78', brightCyan: '#4c806f', brightWhite: '#fafafa'
    },
    editor: {
      background: '#0d1016', foreground: '#bfbdb6', gutterBackground: '#0d1016', gutterForeground: '#4b4c4e', gutterBorder: '#2d2f34', activeLine: '#1f2127bf', activeLineGutter: '#1a1d23',
      selection: '#5ac1fe3d', focus: '#1b4a6e', cursor: '#5ac1fe', panelBackground: '#1f2127', tooltipBackground: '#1f2127', tooltipBorder: '#3f4043',
      keyword: '#ff8f3f', variable: '#bfbdb6', function: '#ffb353', property: '#5ac1fe', type: '#59c2ff', string: '#a9d94b',
      number: '#d2a6ff', comment: '#5c6773', operator: '#f29668', punctuation: '#a6a5a0', meta: '#5ac1fe', invalid: '#ef7177'
    }
  },
  {
    id: 'ayu-mirage',
    label: 'Ayu Mirage',
    mode: 'dark',
    source: { url: 'https://github.com/zed-industries/zed/blob/a3f6ef252b6de19d22a1223952fc335253163642/assets/themes/ayu/ayu.json', license: 'MIT', copyright: 'Copyright (c) 2016 Ike Ku' },
    ui: {
      bg: '#242835', surface: '#353944', 'surface-2': '#43464f', 'surface-3': '#53565d', border: '#53565d', 'border-soft': '#43464f', 'border-focused': '#24556f',
      text: '#cccac2', muted: '#9a9a98', faint: '#7b7d7f', accent: '#72cffe', 'accent-hover': '#87d6fe', 'text-on-accent': '#242835',
      green: '#d5fe80', 'green-surface': '#426117', 'green-border': '#5d7e2c', amber: '#fecf72', 'amber-surface': '#574018',
      danger: '#f18779', 'danger-surface': '#481a1b', 'danger-strong': '#d4776a', 'danger-highlight': '#f07178', 'danger-text': '#f5aba1'
    },
    terminal: {
      background: '#242835', foreground: '#cccac2', cursor: '#72cffe', cursorAccent: '#242835', selectionBackground: '#72cffe3d',
      black: '#242835', red: '#f18779', green: '#d5fe80', yellow: '#fecf72', blue: '#72cffe', magenta: '#5bcde5', cyan: '#95e5cb', white: '#cccac2',
      brightBlack: '#67696e', brightRed: '#833f3c', brightGreen: '#75993c', brightYellow: '#937237', brightBlue: '#336d8d', brightMagenta: '#2b6c7b', brightCyan: '#4c806f', brightWhite: '#fafafa'
    },
    editor: {
      background: '#242835', foreground: '#cccac2', gutterBackground: '#242835', gutterForeground: '#575c6b', gutterBorder: '#43464f', activeLine: '#353944bf', activeLineGutter: '#313540',
      selection: '#72cffe3d', focus: '#24556f', cursor: '#72cffe', panelBackground: '#353944', tooltipBackground: '#353944', tooltipBorder: '#53565d',
      keyword: '#ffad65', variable: '#cccac2', function: '#ffd173', property: '#72cffe', type: '#73cfff', string: '#d4fe7f',
      number: '#dfbfff', comment: '#5c6773', operator: '#f29e74', punctuation: '#b4b3ae', meta: '#72cffe', invalid: '#f18779'
    }
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    mode: 'dark',
    source: { url: 'https://github.com/zed-industries/zed/blob/56cf49bc1afe05bbc777a7df5a01f79299ab4956/assets/themes/gruvbox/gruvbox.json', license: 'MIT', copyright: 'Pavel Pertsev (gruvbox author); the upstream LICENSE leaves its copyright line as a template' },
    ui: {
      bg: '#282828', surface: '#3a3735', 'surface-2': '#494340', 'surface-3': '#5b524c', border: '#5b534d', 'border-soft': '#494340', 'border-focused': '#303a36',
      text: '#fbf1c7', muted: '#c5b597', faint: '#998b78', accent: '#83a598', 'accent-hover': '#95b2a7', 'text-on-accent': '#282828',
      green: '#b7bb26', 'green-surface': '#322b11', 'green-border': '#4a4516', amber: '#f9bd2f', 'amber-surface': '#572e10',
      danger: '#fb4a35', 'danger-surface': '#590a0f', 'danger-strong': '#cc241d', 'danger-highlight': '#ec4632', 'danger-text': '#fc8071'
    },
    terminal: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#83a598', cursorAccent: '#282828', selectionBackground: '#83a5983d',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#fbf1c7'
    },
    editor: {
      background: '#282828', foreground: '#ebdbb2', gutterBackground: '#282828', gutterForeground: '#6e6b5e', gutterBorder: '#494340', activeLine: '#3a3735bf', activeLineGutter: '#353332',
      selection: '#83a5983d', focus: '#303a36', cursor: '#83a598', panelBackground: '#3a3735', tooltipBackground: '#3a3735', tooltipBorder: '#5b534d',
      keyword: '#fb4833', variable: '#ebdbb2', function: '#b8bb25', property: '#ebdbb2', type: '#fabd2e', string: '#b8bb25',
      number: '#d3869b', comment: '#a89984', operator: '#8ec07c', punctuation: '#d5c4a1', meta: '#83a598', invalid: '#fb4a35'
    }
  },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    source: { url: 'https://github.com/dracula/zed/blob/cc33f400374ddd294567faa04904218bef8b648f/themes/dracula.json', license: 'MIT', copyright: 'Copyright (c) 2023 Dracula Theme' },
    ui: {
      bg: '#282a36', surface: '#16121b', 'surface-2': '#3c324b', 'surface-3': '#282232', border: '#383047', 'border-soft': '#48435d', 'border-focused': '#736591',
      text: '#f8f8f2', muted: '#a186c7', faint: '#796998', accent: '#c9a8f9', 'accent-hover': '#e9dbfd', 'text-on-accent': '#16121b',
      green: '#73fb95', 'green-surface': '#222e1d', 'green-border': '#38482f', amber: '#e6e373', 'amber-surface': '#4a4b41',
      danger: '#e67373', 'danger-surface': '#4a3741', 'danger-strong': '#cc4444', 'danger-highlight': '#d86c6c', 'danger-text': '#ed9d9d'
    },
    terminal: {
      background: '#14151b', foreground: '#f8f8f2', cursor: '#bd93f9', cursorAccent: '#14151b', selectionBackground: '#bd93f933',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#9580ff', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#919cbf', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
    },
    editor: {
      background: '#282a36', foreground: '#f8f8f2', gutterBackground: '#282a36', gutterForeground: '#696b71', gutterBorder: '#48435d', activeLine: '#c9a8f933', activeLineGutter: '#48435d',
      selection: '#bd93f933', focus: '#736591', cursor: '#bd93f9', panelBackground: '#16121b', tooltipBackground: '#1e1925', tooltipBorder: '#383047',
      keyword: '#ff79c6', variable: '#f8f8f2', function: '#50fa7b', property: '#8be9fd', type: '#8be9fd', string: '#f1fa8c',
      number: '#bd93f9', comment: '#6272a4', operator: '#ff79c6', punctuation: '#ff79c6', meta: '#8be9fd', invalid: '#e67373'
    }
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    source: { url: 'https://github.com/nordtheme/visual-studio-code/blob/27045851c5154fe2d9b116e7491c596cdcd72275/themes/nord-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)' },
    ui: {
      bg: '#2e3440', surface: '#2e3440', 'surface-2': '#3b4252', 'surface-3': '#434c5e', border: '#3b4252', 'border-soft': '#3b4252', 'border-focused': '#82b7c6',
      text: '#d8dee9', muted: '#949aa5', faint: '#727884', accent: '#88c0d0', 'accent-hover': '#9ac9d7', 'text-on-accent': '#2e3440',
      green: '#a3be8c', 'green-surface': '#434d4e', 'green-border': '#637262', amber: '#ebcb8b', 'amber-surface': '#504f4e',
      danger: '#bf616a', 'danger-surface': '#483c48', 'danger-strong': '#a8555d', 'danger-highlight': '#b45b64', 'danger-text': '#d29096'
    },
    terminal: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5ecc',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
    },
    editor: {
      background: '#2e3440', foreground: '#d8dee9', gutterBackground: '#2e3440', gutterForeground: '#4c566a', gutterBorder: '#3b4252', activeLine: '#3b425299', activeLineGutter: '#3b4252',
      selection: '#434c5ecc', focus: '#82b7c6', cursor: '#d8dee9', panelBackground: '#2e3440', tooltipBackground: '#3b4252', tooltipBorder: '#3b4252',
      keyword: '#81a1c1', variable: '#d8dee9', function: '#88c0d0', property: '#8fbcbb', type: '#8fbcbb', string: '#a3be8c',
      number: '#b48ead', comment: '#616e88', operator: '#81a1c1', punctuation: '#eceff4', meta: '#8fbcbb', invalid: '#bf616a'
    }
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    mode: 'dark',
    source: { url: 'https://github.com/enkia/tokyo-night-vscode-theme/blob/da5546bc4163a02a30d6f3ced90d4ef7dfcb8460/themes/tokyo-night-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2018-present Enkia' },
    ui: {
      bg: '#1a1b26', surface: '#16161e', 'surface-2': '#1c1d29', 'surface-3': '#202330', border: '#101014', 'border-soft': '#1c1d29', 'border-focused': '#385191',
      text: '#a9b1d6', muted: '#787c99', faint: '#4d4f64', accent: '#6183bb', 'accent-hover': '#6d91de', 'text-on-accent': '#16161e',
      green: '#449dab', 'green-surface': '#22323e', 'green-border': '#2d5662', amber: '#e0af68', 'amber-surface': '#3e3632',
      danger: '#db4b4b', 'danger-surface': '#3d242d', 'danger-strong': '#963c47', 'danger-highlight': '#bb616b', 'danger-text': '#de5971'
    },
    terminal: {
      background: '#16161e', foreground: '#787c99', cursor: '#c0caf5', cursorAccent: '#16161e', selectionBackground: '#515c7e4d',
      black: '#363b54', red: '#f7768e', green: '#73daca', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#787c99',
      brightBlack: '#363b54', brightRed: '#f7768e', brightGreen: '#73daca', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#acb0d0'
    },
    editor: {
      background: '#1a1b26', foreground: '#a9b1d6', gutterBackground: '#1a1b26', gutterForeground: '#363b54', gutterBorder: '#1c1d29', activeLine: '#1e202e99', activeLineGutter: '#1e202e',
      selection: '#515c7e4d', focus: '#385191', cursor: '#c0caf5', panelBackground: '#16161e', tooltipBackground: '#16161e', tooltipBorder: '#101014',
      keyword: '#bb9af7', variable: '#c0caf5', function: '#7aa2f7', property: '#0db9d7', type: '#c0caf5', string: '#9ece6a',
      number: '#ff9e64', comment: '#51597d', operator: '#89ddff', punctuation: '#89ddff', meta: '#bb9af7', invalid: '#ff5370'
    }
  },
  {
    id: 'tokyo-night-storm',
    label: 'Tokyo Night Storm',
    mode: 'dark',
    source: { url: 'https://github.com/enkia/tokyo-night-vscode-theme/blob/da5546bc4163a02a30d6f3ced90d4ef7dfcb8460/themes/tokyo-night-storm-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2018-present Enkia' },
    ui: {
      bg: '#24283b', surface: '#1f2335', 'surface-2': '#1b1e2e', 'surface-3': '#2c324a', border: '#1b1e2e', 'border-soft': '#1b1e2e', 'border-focused': '#3a5293',
      text: '#a9b1d6', muted: '#8089b3', faint: '#4a5272', accent: '#668ac4', 'accent-hover': '#6d91de', 'text-on-accent': '#1f2335',
      green: '#449dab', 'green-surface': '#2a3d4f', 'green-border': '#325d6e', amber: '#e0af68', 'amber-surface': '#464043',
      danger: '#db4b4b', 'danger-surface': '#452e3e', 'danger-strong': '#963c47', 'danger-highlight': '#bb616b', 'danger-text': '#f7768e'
    },
    terminal: {
      background: '#1f2335', foreground: '#8089b3', cursor: '#c0caf5', cursorAccent: '#1f2335', selectionBackground: '#6f7bb640',
      black: '#414868', red: '#f7768e', green: '#73daca', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#8089b3',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#73daca', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#a9b1d6'
    },
    editor: {
      background: '#24283b', foreground: '#a9b1d6', gutterBackground: '#24283b', gutterForeground: '#3b4261', gutterBorder: '#1b1e2e', activeLine: '#292e4299', activeLineGutter: '#292e42',
      selection: '#6f7bb640', focus: '#3a5293', cursor: '#c0caf5', panelBackground: '#1f2335', tooltipBackground: '#1f2335', tooltipBorder: '#1b1e2e',
      keyword: '#bb9af7', variable: '#c0caf5', function: '#7aa2f7', property: '#2ac3de', type: '#c0caf5', string: '#9ece6a',
      number: '#ff9e64', comment: '#5f6996', operator: '#89ddff', punctuation: '#89ddff', meta: '#bb9af7', invalid: '#ff5370'
    }
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    mode: 'dark',
    source: { url: 'https://github.com/catppuccin/zed/blob/0ec5fee4acefadc5baef03a5085adace19fc852f/themes/catppuccin-mauve.json', license: 'MIT', copyright: 'Copyright (c) 2021 Catppuccin' },
    ui: {
      bg: '#1e1e2e', surface: '#181825', 'surface-2': '#313244', 'surface-3': '#20202e', border: '#313244', 'border-soft': '#2c293d', 'border-focused': '#b4befe',
      text: '#cdd6f4', muted: '#bac2de', faint: '#585b70', accent: '#cba6f7', 'accent-hover': '#d3b3f8', 'text-on-accent': '#11111b',
      green: '#a6e3a1', 'green-surface': '#374243', 'green-border': '#a6e3a1', amber: '#f9e2af', 'amber-surface': '#464145',
      danger: '#f38ba8', 'danger-surface': '#443244', 'danger-strong': '#f37799', 'danger-highlight': '#f37799', 'danger-text': '#f7aec2'
    },
    terminal: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#9399b240',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#a6adc8',
      brightBlack: '#585b70', brightRed: '#f37799', brightGreen: '#89d88b', brightYellow: '#ebd391', brightBlue: '#74a8fc', brightMagenta: '#f2aede', brightCyan: '#6bd7ca', brightWhite: '#bac2de'
    },
    editor: {
      background: '#1e1e2e', foreground: '#cdd6f4', gutterBackground: '#1e1e2e', gutterForeground: '#7f849c', gutterBorder: '#2c293d', activeLine: '#cdd6f412', activeLineGutter: '#2a2b3c',
      selection: '#9399b240', focus: '#b4befe', cursor: '#f5e0dc', panelBackground: '#181825', tooltipBackground: '#181825', tooltipBorder: '#313244',
      keyword: '#cba6f7', variable: '#cdd6f4', function: '#89b4fa', property: '#b4befe', type: '#f9e2af', string: '#a6e3a1',
      number: '#fab387', comment: '#9399b2', operator: '#89dceb', punctuation: '#9399b2', meta: '#f9e2af', invalid: '#f38ba8'
    }
  },
  {
    id: 'catppuccin-macchiato',
    label: 'Catppuccin Macchiato',
    mode: 'dark',
    source: { url: 'https://github.com/catppuccin/zed/blob/0ec5fee4acefadc5baef03a5085adace19fc852f/themes/catppuccin-mauve.json', license: 'MIT', copyright: 'Copyright (c) 2021 Catppuccin' },
    ui: {
      bg: '#24273a', surface: '#1e2030', 'surface-2': '#363a4f', 'surface-3': '#252839', border: '#363a4f', 'border-soft': '#313148', 'border-focused': '#b7bdf8',
      text: '#cad3f5', muted: '#b8c0e0', faint: '#5b6078', accent: '#c6a0f6', 'accent-hover': '#ceaef7', 'text-on-accent': '#181926',
      green: '#a6da95', 'green-surface': '#3b474a', 'green-border': '#a6da95', amber: '#eed49f', 'amber-surface': '#48464c',
      danger: '#ed8796', 'danger-surface': '#48384b', 'danger-strong': '#ec7486', 'danger-highlight': '#ec7486', 'danger-text': '#ee99a0'
    },
    terminal: {
      background: '#24273a', foreground: '#cad3f5', cursor: '#f4dbd6', cursorAccent: '#24273a', selectionBackground: '#939ab740',
      black: '#494d64', red: '#ed8796', green: '#a6da95', yellow: '#eed49f', blue: '#8aadf4', magenta: '#f5bde6', cyan: '#8bd5ca', white: '#a5adcb',
      brightBlack: '#5b6078', brightRed: '#ec7486', brightGreen: '#8ccf7f', brightYellow: '#e1c682', brightBlue: '#78a1f6', brightMagenta: '#f2a9dd', brightCyan: '#63cbc0', brightWhite: '#b8c0e0'
    },
    editor: {
      background: '#24273a', foreground: '#cad3f5', gutterBackground: '#24273a', gutterForeground: '#8087a2', gutterBorder: '#313148', activeLine: '#cad3f512', activeLineGutter: '#303347',
      selection: '#939ab740', focus: '#b7bdf8', cursor: '#f4dbd6', panelBackground: '#1e2030', tooltipBackground: '#1e2030', tooltipBorder: '#363a4f',
      keyword: '#c6a0f6', variable: '#cad3f5', function: '#8aadf4', property: '#b7bdf8', type: '#eed49f', string: '#a6da95',
      number: '#f5a97f', comment: '#939ab7', operator: '#91d7e3', punctuation: '#939ab7', meta: '#eed49f', invalid: '#ed8796'
    }
  },
  {
    id: 'catppuccin-frappe',
    label: 'Catppuccin Frappé',
    mode: 'dark',
    source: { url: 'https://github.com/catppuccin/zed/blob/0ec5fee4acefadc5baef03a5085adace19fc852f/themes/catppuccin-mauve.json', license: 'MIT', copyright: 'Copyright (c) 2021 Catppuccin' },
    ui: {
      bg: '#303446', surface: '#292c3c', 'surface-2': '#414559', 'surface-3': '#303445', border: '#414559', 'border-soft': '#3c3c53', 'border-focused': '#babbf1',
      text: '#c6d0f5', muted: '#b5bfe2', faint: '#626880', accent: '#ca9ee6', 'accent-hover': '#d2acea', 'text-on-accent': '#232634',
      green: '#a6d189', 'green-surface': '#455052', 'green-border': '#a6d189', amber: '#e5c890', 'amber-surface': '#514f53',
      danger: '#e78284', 'danger-surface': '#514251', 'danger-strong': '#e67172', 'danger-highlight': '#e67172', 'danger-text': '#ea999c'
    },
    terminal: {
      background: '#303446', foreground: '#c6d0f5', cursor: '#f2d5cf', cursorAccent: '#303446', selectionBackground: '#949cbb40',
      black: '#51576d', red: '#e78284', green: '#a6d189', yellow: '#e5c890', blue: '#8caaee', magenta: '#f4b8e4', cyan: '#81c8be', white: '#a5adce',
      brightBlack: '#626880', brightRed: '#e67172', brightGreen: '#8ec772', brightYellow: '#d9ba73', brightBlue: '#7b9ef0', brightMagenta: '#f4b8e4', brightCyan: '#5abfb5', brightWhite: '#b5bfe2'
    },
    editor: {
      background: '#303446', foreground: '#c6d0f5', gutterBackground: '#303446', gutterForeground: '#838ba7', gutterBorder: '#3c3c53', activeLine: '#c6d0f512', activeLineGutter: '#3b3f52',
      selection: '#949cbb40', focus: '#babbf1', cursor: '#f2d5cf', panelBackground: '#292c3c', tooltipBackground: '#292c3c', tooltipBorder: '#414559',
      keyword: '#ca9ee6', variable: '#c6d0f5', function: '#8caaee', property: '#babbf1', type: '#e5c890', string: '#a6d189',
      number: '#ef9f76', comment: '#949cbb', operator: '#99d1db', punctuation: '#949cbb', meta: '#e5c890', invalid: '#e78284'
    }
  },
  {
    id: 'github-dark-default',
    label: 'GitHub Dark Default',
    mode: 'dark',
    source: { url: 'https://github.com/primer/github-vscode-theme/blob/cd78e5e4e7bcf132a6f428ae0f32264bb1b729cf/src/theme.js', license: 'MIT', copyright: 'Copyright (c) 2020 Primer' },
    ui: {
      bg: '#0d1117', surface: '#010409', 'surface-2': '#0c1015', 'surface-3': '#2d3239', border: '#30363d', 'border-soft': '#272c32', 'border-focused': '#1f6feb',
      text: '#e6edf3', muted: '#7d8590', faint: '#6e7681', accent: '#2f81f7', 'accent-hover': '#58a6ff', 'text-on-accent': '#010409',
      green: '#3fb950', 'green-surface': '#162f21', 'green-border': '#245d31', amber: '#d29922', 'amber-surface': '#312a19',
      danger: '#f85149', 'danger-surface': '#371d20', 'danger-strong': '#da4740', 'danger-highlight': '#e94c45', 'danger-text': '#ff7b72'
    },
    terminal: {
      background: '#010409', foreground: '#e6edf3', cursor: '#2f81f7', cursorAccent: '#010409', selectionBackground: '#264f78',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff'
    },
    editor: {
      background: '#0d1117', foreground: '#e6edf3', gutterBackground: '#0d1117', gutterForeground: '#6e7681', gutterBorder: '#272c32', activeLine: '#6e76811a', activeLineGutter: '#171b22',
      selection: '#264f78', focus: '#1f6feb', cursor: '#2f81f7', panelBackground: '#161b22', tooltipBackground: '#161b22', tooltipBorder: '#30363d',
      keyword: '#ff7b72', variable: '#e6edf3', function: '#d2a8ff', property: '#7ee787', type: '#ffa657', string: '#a5d6ff',
      number: '#79c0ff', comment: '#8b949e', operator: '#ff7b72', punctuation: '#e6edf3', meta: '#79c0ff', invalid: '#ffa198'
    }
  },
  {
    id: 'github-dark-dimmed',
    label: 'GitHub Dark Dimmed',
    mode: 'dark',
    source: { url: 'https://github.com/primer/github-vscode-theme/blob/cd78e5e4e7bcf132a6f428ae0f32264bb1b729cf/src/theme.js', license: 'MIT', copyright: 'Copyright (c) 2020 Primer' },
    ui: {
      bg: '#22272e', surface: '#1c2128', 'surface-2': '#232930', 'surface-3': '#384049', border: '#444c56', 'border-soft': '#333941', 'border-focused': '#316dca',
      text: '#adbac7', muted: '#768390', faint: '#636e7b', accent: '#539bf5', 'accent-hover': '#6cb6ff', 'text-on-accent': '#1c2128',
      green: '#57ab5a', 'green-surface': '#2c3f36', 'green-border': '#3a6342', amber: '#c69026', 'amber-surface': '#403a2d',
      danger: '#e5534b', 'danger-surface': '#452f33', 'danger-strong': '#c94942', 'danger-highlight': '#d84e47', 'danger-text': '#f47067'
    },
    terminal: {
      background: '#1c2128', foreground: '#adbac7', cursor: '#539bf5', cursorAccent: '#1c2128', selectionBackground: '#264f78',
      black: '#545d68', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#909dab',
      brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#cdd9e5'
    },
    editor: {
      background: '#22272e', foreground: '#adbac7', gutterBackground: '#22272e', gutterForeground: '#636e7b', gutterBorder: '#333941', activeLine: '#636e7b1a', activeLineGutter: '#292e36',
      selection: '#264f78', focus: '#316dca', cursor: '#539bf5', panelBackground: '#2d333b', tooltipBackground: '#2d333b', tooltipBorder: '#444c56',
      keyword: '#f47067', variable: '#adbac7', function: '#dcbdfb', property: '#8ddb8c', type: '#f69d50', string: '#96d0ff',
      number: '#6cb6ff', comment: '#768390', operator: '#f47067', punctuation: '#adbac7', meta: '#6cb6ff', invalid: '#ff938a'
    }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    mode: 'dark',
    source: { url: 'https://github.com/microsoft/vscode/blob/e886f3e07de31233c89ecdba812b05bfd07616d7/extensions/theme-solarized-dark/themes/solarized-dark-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2015 - present Microsoft Corporation; Copyright (c) 2015 Colorsublime.com' },
    ui: {
      bg: '#002b36', surface: '#00212b', 'surface-2': '#003846', 'surface-3': '#003441', border: '#2b2b4a', 'border-soft': '#003846', 'border-focused': '#197271',
      text: '#839496', muted: '#627a7d', faint: '#586e75', accent: '#2aa198', 'accent-hover': '#4aafa7', 'text-on-accent': '#00212b',
      green: '#859900', 'green-surface': '#183f2c', 'green-border': '#3c5d1e', amber: '#b58900', 'amber-surface': '#213c2c',
      danger: '#dc322f', 'danger-surface': '#282c35', 'danger-strong': '#c12c29', 'danger-highlight': '#cf2f2c', 'danger-text': '#e66f6d'
    },
    terminal: {
      background: '#002b36', foreground: '#839496', cursor: '#d30102', cursorAccent: '#002b36', selectionBackground: '#274642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    },
    editor: {
      background: '#002b36', foreground: '#839496', gutterBackground: '#002b36', gutterForeground: '#858585', gutterBorder: '#003846', activeLine: '#07364299', activeLineGutter: '#073642',
      selection: '#274642', focus: '#197271', cursor: '#d30102', panelBackground: '#00212b', tooltipBackground: '#004052', tooltipBorder: '#2b2b4a',
      keyword: '#859900', variable: '#268bd2', function: '#268bd2', property: '#859900', type: '#cb4b16', string: '#2aa198',
      number: '#d33682', comment: '#586e75', operator: '#859900', punctuation: '#839496', meta: '#93a1a1', invalid: '#dc322f'
    }
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    mode: 'dark',
    source: { url: 'https://github.com/rose-pine/zed/blob/b77535f1560bc141a933b66ba5a56b44b273cf08/themes/rose-pine.json', license: 'MIT', copyright: 'Copyright (c) Rosé Pine' },
    ui: {
      bg: '#191724', surface: '#191724', 'surface-2': '#26233a', 'surface-3': '#524f67', border: '#403d52', 'border-soft': '#524f67', 'border-focused': '#1f1d2e',
      text: '#e0def4', muted: '#908caa', faint: '#6e6a86', accent: '#9ccfd8', 'accent-hover': '#abd6de', 'text-on-accent': '#191724',
      green: '#9ccfd8', 'green-surface': '#21202e', 'green-border': '#9ccfd8', amber: '#f6c177', 'amber-surface': '#21202e',
      danger: '#eb6f92', 'danger-surface': '#21202e', 'danger-strong': '#ce6280', 'danger-highlight': '#dd6889', 'danger-text': '#f19ab2'
    },
    terminal: {
      background: '#191724', foreground: '#e0def4', cursor: '#e0def4', cursorAccent: '#191724', selectionBackground: '#e0def422',
      black: '#21202e', red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#908caa', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4'
    },
    editor: {
      background: '#191724', foreground: '#e0def4', gutterBackground: '#191724', gutterForeground: '#6e6a86', gutterBorder: '#524f67', activeLine: '#1f1d2e99', activeLineGutter: '#1f1d2e',
      selection: '#e0def422', focus: '#1f1d2e', cursor: '#e0def4', panelBackground: '#191724', tooltipBackground: '#1f1d2e', tooltipBorder: '#403d52',
      keyword: '#31748f', variable: '#e0def4', function: '#ebbcba', property: '#c4a7e7', type: '#9ccfd8', string: '#f6c177',
      number: '#ebbcba', comment: '#6e6a86', operator: '#908caa', punctuation: '#908caa', meta: '#c4a7e7', invalid: '#eb6f92'
    }
  },
  {
    id: 'rose-pine-moon',
    label: 'Rosé Pine Moon',
    mode: 'dark',
    source: { url: 'https://github.com/rose-pine/zed/blob/b77535f1560bc141a933b66ba5a56b44b273cf08/themes/rose-pine-moon.json', license: 'MIT', copyright: 'Copyright (c) Rosé Pine' },
    ui: {
      bg: '#232136', surface: '#232136', 'surface-2': '#393552', 'surface-3': '#56526e', border: '#44415a', 'border-soft': '#56526e', 'border-focused': '#2a273f',
      text: '#e0def4', muted: '#908caa', faint: '#6e6a86', accent: '#9ccfd8', 'accent-hover': '#abd6de', 'text-on-accent': '#232136',
      green: '#9ccfd8', 'green-surface': '#2a283e', 'green-border': '#9ccfd8', amber: '#f6c177', 'amber-surface': '#2a283e',
      danger: '#eb6f92', 'danger-surface': '#2a283e', 'danger-strong': '#ce6280', 'danger-highlight': '#dd6889', 'danger-text': '#f19ab2'
    },
    terminal: {
      background: '#232136', foreground: '#e0def4', cursor: '#e0def4', cursorAccent: '#232136', selectionBackground: '#e0def422',
      black: '#2a283e', red: '#eb6f92', green: '#3e8fb0', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ea9a97', white: '#e0def4',
      brightBlack: '#908caa', brightRed: '#eb6f92', brightGreen: '#3e8fb0', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ea9a97', brightWhite: '#e0def4'
    },
    editor: {
      background: '#232136', foreground: '#e0def4', gutterBackground: '#232136', gutterForeground: '#6e6a86', gutterBorder: '#56526e', activeLine: '#2a273f99', activeLineGutter: '#2a273f',
      selection: '#e0def422', focus: '#2a273f', cursor: '#e0def4', panelBackground: '#232136', tooltipBackground: '#2a273f', tooltipBorder: '#44415a',
      keyword: '#3e8fb0', variable: '#e0def4', function: '#ea9a97', property: '#c4a7e7', type: '#9ccfd8', string: '#f6c177',
      number: '#ea9a97', comment: '#6e6a86', operator: '#908caa', punctuation: '#908caa', meta: '#c4a7e7', invalid: '#eb6f92'
    }
  },
  {
    id: 'everforest-dark',
    label: 'Everforest Dark',
    mode: 'dark',
    source: { url: 'https://github.com/sainnhe/everforest-vscode/blob/b039b30727868d77108ec85f0be66e6d80a9bc1f/themes/everforest-dark.json', license: 'MIT', copyright: 'Copyright (c) 2020 sainnhe' },
    ui: {
      bg: '#2d353b', surface: '#2d353b', 'surface-2': '#3a444a', 'surface-3': '#3a444a', border: '#21272b', 'border-soft': '#3a444a', 'border-focused': '#a7c080',
      text: '#d3c6aa', muted: '#859289', faint: '#606a64', accent: '#a7c080', 'accent-hover': '#b4c993', 'text-on-accent': '#2d353b',
      green: '#a7c080', 'green-surface': '#434e47', 'green-border': '#64745a', amber: '#bf983d', 'amber-surface': '#47473b',
      danger: '#da6362', 'danger-surface': '#4c3d42', 'danger-strong': '#bf5756', 'danger-highlight': '#cd5d5c', 'danger-text': '#e67e80'
    },
    terminal: {
      background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', cursorAccent: '#2d353b', selectionBackground: '#475258c0',
      black: '#343f44', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#859289', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f', brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#d3c6aa'
    },
    editor: {
      background: '#2d353b', foreground: '#d3c6aa', gutterBackground: '#2d353b', gutterForeground: '#606a64', gutterBorder: '#3a444a', activeLine: '#3d484d90', activeLineGutter: '#364045',
      selection: '#475258c0', focus: '#a7c080', cursor: '#d3c6aa', panelBackground: '#2d353b', tooltipBackground: '#343f44', tooltipBorder: '#475258',
      keyword: '#e67e80', variable: '#d3c6aa', function: '#a7c080', property: '#e69875', type: '#83c092', string: '#dbbc7f',
      number: '#d699b6', comment: '#859289', operator: '#e69875', punctuation: '#d3c6aa', meta: '#dbbc7f', invalid: '#da6362'
    }
  },
  {
    id: 'kanagawa-wave',
    label: 'Kanagawa Wave',
    mode: 'dark',
    source: { url: 'https://github.com/rebelot/kanagawa.nvim/tree/bc78b40443e1166f1c4f77f466a2e58c04ae6535', license: 'MIT', copyright: 'Copyright (c) 2021 Tommaso Laurenzi' },
    ui: {
      bg: '#1f1f28', surface: '#16161d', 'surface-2': '#2a2a37', 'surface-3': '#363646', border: '#54546d', 'border-soft': '#2a2a37', 'border-focused': '#2d4f67',
      text: '#dcd7ba', muted: '#c8c093', faint: '#727169', accent: '#7e9cd8', 'accent-hover': '#9cabca', 'text-on-accent': '#16161d',
      green: '#76946a', 'green-surface': '#2b3328', 'green-border': '#465446', amber: '#ff9e3b', 'amber-surface': '#49443c',
      danger: '#e82424', 'danger-surface': '#43242b', 'danger-strong': '#cc2020', 'danger-highlight': '#c34043', 'danger-text': '#e46876'
    },
    terminal: {
      background: '#1f1f28', foreground: '#dcd7ba', cursor: '#c8c093', cursorAccent: '#1f1f28', selectionBackground: '#2d4f67',
      black: '#16161d', red: '#c34043', green: '#76946a', yellow: '#c0a36e', blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
      brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384', brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba'
    },
    editor: {
      background: '#1f1f28', foreground: '#dcd7ba', gutterBackground: '#2a2a37', gutterForeground: '#54546d', gutterBorder: '#2a2a37', activeLine: '#36364699', activeLineGutter: '#363646',
      selection: '#223249', focus: '#2d4f67', cursor: '#dcd7ba', panelBackground: '#16161d', tooltipBackground: '#16161d', tooltipBorder: '#54546d',
      keyword: '#957fb8', variable: '#dcd7ba', function: '#7e9cd8', property: '#e6c384', type: '#68ad99', string: '#98bb6c',
      number: '#d27e99', comment: '#727169', operator: '#c0a36e', punctuation: '#9cabca', meta: '#ffa066', invalid: '#e82424'
    }
  },
  {
    id: 'night-owl',
    label: 'Night Owl',
    mode: 'dark',
    source: { url: 'https://github.com/sdras/night-owl-vscode-theme/blob/d298950d6378c36c027f1387e307ebf3f145fc90/themes/Night%20Owl-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2018 Sarah Drasner' },
    ui: {
      bg: '#011627', surface: '#011627', 'surface-2': '#0e293f', 'surface-3': '#14344f', border: '#5f7e97', 'border-soft': '#272b3b', 'border-focused': '#122d42',
      text: '#d6deeb', muted: '#5f7e97', faint: '#4b6479', accent: '#7e57c2', 'accent-hover': '#9170cb', 'text-on-accent': '#021320',
      green: '#c5e478', 'green-surface': '#243b36', 'green-border': '#59734c', amber: '#b39554', 'amber-surface': '#212d2f',
      danger: '#ef5350', 'danger-surface': '#2c212e', 'danger-strong': '#d3423e', 'danger-highlight': '#e14e4b', 'danger-text': '#ff6363'
    },
    terminal: {
      background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2', cursorAccent: '#234d70', selectionBackground: '#1b90dd4d',
      black: '#011627', red: '#ef5350', green: '#22da6e', yellow: '#c5e478', blue: '#82aaff', magenta: '#c792ea', cyan: '#21c7a8', white: '#ffffff',
      brightBlack: '#575656', brightRed: '#ef5350', brightGreen: '#22da6e', brightYellow: '#ffeb95', brightBlue: '#82aaff', brightMagenta: '#c792ea', brightCyan: '#7fdbca', brightWhite: '#ffffff'
    },
    editor: {
      background: '#011627', foreground: '#d6deeb', gutterBackground: '#011627', gutterForeground: '#4b6479', gutterBorder: '#272b3b', activeLine: '#28707d29', activeLineGutter: '#072435',
      selection: '#1d3b53', focus: '#122d42', cursor: '#80a4c2', panelBackground: '#021320', tooltipBackground: '#011627', tooltipBorder: '#5f7e97',
      keyword: '#c792ea', variable: '#d6deeb', function: '#82aaff', property: '#7fdbca', type: '#ffcb8b', string: '#ecc48d',
      number: '#f78c6c', comment: '#637777', operator: '#c792ea', punctuation: '#d6deeb', meta: '#c5e478', invalid: '#ffffff'
    }
  },
  {
    id: 'vscode-dark-modern',
    label: 'Dark Modern',
    mode: 'dark',
    source: { url: 'https://github.com/microsoft/vscode/blob/ab8f31f0c0b1a4dd86d8dbee1248542f5806574d/extensions/theme-defaults/themes/dark_modern.json', license: 'MIT', copyright: 'Copyright (c) 2015 - present Microsoft Corporation' },
    ui: {
      bg: '#1f1f1f', surface: '#181818', 'surface-2': '#2a2d2e', 'surface-3': '#04395e', border: '#2b2b2b', 'border-soft': '#2a2d2e', 'border-focused': '#0078d4',
      text: '#cccccc', muted: '#9d9d9d', faint: '#6e7681', accent: '#4daafc', 'accent-hover': '#68b7fc', 'text-on-accent': '#181818',
      green: '#81b88b', 'green-surface': '#313b32', 'green-border': '#4b6450', amber: '#cca700', 'amber-surface': '#3e3819',
      danger: '#f85149', 'danger-surface': '#462827', 'danger-strong': '#da4740', 'danger-highlight': '#f44747', 'danger-text': '#fa857f'
    },
    terminal: {
      background: '#181818', foreground: '#cccccc', cursor: '#aeafad', cursorAccent: '#181818', selectionBackground: '#264f78',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5'
    },
    editor: {
      background: '#1f1f1f', foreground: '#cccccc', gutterBackground: '#1f1f1f', gutterForeground: '#6e7681', gutterBorder: '#2a2d2e', activeLine: '#28282899', activeLineGutter: '#282828',
      selection: '#264f78', focus: '#0078d4', cursor: '#aeafad', panelBackground: '#202020', tooltipBackground: '#202020', tooltipBorder: '#313131',
      keyword: '#c586c0', variable: '#9cdcfe', function: '#dcdcaa', property: '#9cdcfe', type: '#4ec9b0', string: '#ce9178',
      number: '#b5cea8', comment: '#6a9955', operator: '#d4d4d4', punctuation: '#cccccc', meta: '#9cdcfe', invalid: '#f44747'
    }
  },
  {
    id: 'monokai',
    label: 'Monokai',
    mode: 'dark',
    source: { url: 'https://github.com/microsoft/vscode/blob/e886f3e07de31233c89ecdba812b05bfd07616d7/extensions/theme-monokai/themes/monokai-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2015 - present Microsoft Corporation; Copyright (c) 2015 Colorsublime.com' },
    ui: {
      bg: '#272822', surface: '#1e1f1c', 'surface-2': '#3e3d32', 'surface-3': '#75715e', border: '#414339', 'border-soft': '#34352f', 'border-focused': '#99947c',
      text: '#f8f8f2', muted: '#ccccc7', faint: '#90908a', accent: '#75715e', 'accent-hover': '#8a8676', 'text-on-accent': '#1e1f1c',
      green: '#86b42b', 'green-surface': '#384124', 'green-border': '#526726', amber: '#b3b42b', 'amber-surface': '#404124',
      danger: '#c4265e', 'danger-surface': '#43282d', 'danger-strong': '#90274a', 'danger-highlight': '#b82458', 'danger-text': '#d97296'
    },
    terminal: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: '#878b9180',
      black: '#333333', red: '#c4265e', green: '#86b42b', yellow: '#b3b42b', blue: '#6a7ec8', magenta: '#8c6bc8', cyan: '#56adbc', white: '#e3e3dd',
      brightBlack: '#666666', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#e2e22e', brightBlue: '#819aff', brightMagenta: '#ae81ff', brightCyan: '#66d9ef', brightWhite: '#f8f8f2'
    },
    editor: {
      background: '#272822', foreground: '#f8f8f2', gutterBackground: '#272822', gutterForeground: '#90908a', gutterBorder: '#34352f', activeLine: '#3e3d3299', activeLineGutter: '#3e3d32',
      selection: '#878b9180', focus: '#99947c', cursor: '#f8f8f0', panelBackground: '#1e1f1c', tooltipBackground: '#414339', tooltipBorder: '#75715e',
      keyword: '#f92672', variable: '#f8f8f2', function: '#a6e22e', property: '#66d9ef', type: '#a6e22e', string: '#e6db74',
      number: '#ae81ff', comment: '#88846f', operator: '#f92672', punctuation: '#f8f8f2', meta: '#a6e22e', invalid: '#f44747'
    }
  },
  {
    id: 'ayu-light',
    label: 'Ayu Light',
    mode: 'light',
    source: { url: 'https://github.com/zed-industries/zed/blob/a3f6ef252b6de19d22a1223952fc335253163642/assets/themes/ayu/ayu.json', license: 'MIT', copyright: 'Copyright (c) 2016 Ike Ku' },
    ui: {
      bg: '#fcfcfc', surface: '#ececed', 'surface-2': '#dfe0e1', 'surface-3': '#cfd0d2', border: '#cfd1d2', 'border-soft': '#dfe0e1', 'border-focused': '#c4daf6',
      text: '#5c6166', muted: '#8b8e92', faint: '#a9acae', accent: '#3b9ee5', 'accent-hover': '#3286c3', 'text-on-accent': '#313435',
      green: '#85b304', 'green-surface': '#e9efd2', 'green-border': '#d7e3ae', amber: '#f1ad49', 'amber-surface': '#ffeeda',
      danger: '#ef7271', 'danger-surface': '#ffe3e1', 'danger-strong': '#d26463', 'danger-highlight': '#e16b6a', 'danger-text': '#ae5352'
    },
    terminal: {
      background: '#fcfcfc', foreground: '#5c6166', cursor: '#3b9ee5', cursorAccent: '#fcfcfc', selectionBackground: '#3b9ee53d',
      black: '#5c6166', red: '#ef7271', green: '#85b304', yellow: '#f1ad49', blue: '#3b9ee5', magenta: '#55b4d3', cyan: '#4dbf99', white: '#fcfcfc',
      brightBlack: '#3b9ee5', brightRed: '#febab6', brightGreen: '#c7d98f', brightYellow: '#fed5a3', brightBlue: '#abcdf2', brightMagenta: '#b1d8e8', brightCyan: '#ace0cb', brightWhite: '#ffffff'
    },
    editor: {
      background: '#fcfcfc', foreground: '#5c6166', gutterBackground: '#fcfcfc', gutterForeground: '#b0b3b5', gutterBorder: '#dfe0e1', activeLine: '#ececedbf', activeLineGutter: '#f0f0f1',
      selection: '#3b9ee53d', focus: '#c4daf6', cursor: '#3b9ee5', panelBackground: '#ececed', tooltipBackground: '#ececed', tooltipBorder: '#cfd1d2',
      keyword: '#fa8d3e', variable: '#5c6166', function: '#f2ad48', property: '#3b9ee5', type: '#389ee6', string: '#86b300',
      number: '#a37acc', comment: '#abb0b6', operator: '#ed9365', punctuation: '#73777b', meta: '#3b9ee5', invalid: '#ef7271'
    }
  },
  {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    mode: 'light',
    source: { url: 'https://github.com/zed-industries/zed/blob/56cf49bc1afe05bbc777a7df5a01f79299ab4956/assets/themes/gruvbox/gruvbox.json', license: 'MIT', copyright: 'Pavel Pertsev (gruvbox author); the upstream LICENSE leaves its copyright line as a template' },
    ui: {
      bg: '#fbf1c7', surface: '#ecddb4', 'surface-2': '#ddcca7', 'surface-3': '#c8b899', border: '#c8b899', 'border-soft': '#ddcca7', 'border-focused': '#adc5cc',
      text: '#282828', muted: '#5f5650', faint: '#897b6e', accent: '#0b6678', 'accent-hover': '#095766', 'text-on-accent': '#fbf1c7',
      green: '#797410', 'green-surface': '#e4e0cd', 'green-border': '#d1cba8', amber: '#b57615', 'amber-surface': '#f5e2d0',
      danger: '#9d0308', 'danger-surface': '#f4d1c9', 'danger-strong': '#8a0307', 'danger-highlight': '#940308', 'danger-text': '#830207'
    },
    terminal: {
      background: '#fbf1c7', foreground: '#282828', cursor: '#0b6678', cursorAccent: '#fbf1c7', selectionBackground: '#0b66783d',
      black: '#fbf1c7', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
      brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614', brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#282828'
    },
    editor: {
      background: '#fbf1c7', foreground: '#282828', gutterBackground: '#fbf1c7', gutterForeground: '#a9a389', gutterBorder: '#ddcca7', activeLine: '#ecddb4bf', activeLineGutter: '#f0e2b9',
      selection: '#0b66783d', focus: '#adc5cc', cursor: '#0b6678', panelBackground: '#ecddb4', tooltipBackground: '#ecddb4', tooltipBorder: '#c8b899',
      keyword: '#9d0006', variable: '#282828', function: '#79740e', property: '#282828', type: '#b57613', string: '#79740e',
      number: '#8f3e71', comment: '#7c6f64', operator: '#427b58', punctuation: '#3c3836', meta: '#0b6678', invalid: '#9d0308'
    }
  },
  {
    id: 'github-light-default',
    label: 'GitHub Light Default',
    mode: 'light',
    source: { url: 'https://github.com/primer/github-vscode-theme/blob/cd78e5e4e7bcf132a6f428ae0f32264bb1b729cf/src/theme.js', license: 'MIT', copyright: 'Copyright (c) 2020 Primer' },
    ui: {
      bg: '#ffffff', surface: '#f6f8fa', 'surface-2': '#f0f3f6', 'surface-3': '#e8ebef', border: '#d0d7de', 'border-soft': '#e4e4e5', 'border-focused': '#0969da',
      text: '#1f2328', muted: '#656d76', faint: '#8c959f', accent: '#0969da', 'accent-hover': '#0550ae', 'text-on-accent': '#ffffff',
      green: '#1a7f37', 'green-surface': '#e3efe7', 'green-border': '#98c5a5', amber: '#9a6700', 'amber-surface': '#f3ede0',
      danger: '#cf222e', 'danger-surface': '#f9e4e6', 'danger-strong': '#a40e26', 'danger-highlight': '#c3202b', 'danger-text': '#a40e26'
    },
    terminal: {
      background: '#f6f8fa', foreground: '#1f2328', cursor: '#0969da', cursorAccent: '#f6f8fa', selectionBackground: '#add6ff',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f'
    },
    editor: {
      background: '#ffffff', foreground: '#1f2328', gutterBackground: '#ffffff', gutterForeground: '#8c959f', gutterBorder: '#e4e4e5', activeLine: '#eaeef280', activeLineGutter: '#f4f6f8',
      selection: '#add6ff', focus: '#0969da', cursor: '#0969da', panelBackground: '#ffffff', tooltipBackground: '#ffffff', tooltipBorder: '#d0d7de',
      keyword: '#cf222e', variable: '#1f2328', function: '#8250df', property: '#116329', type: '#953800', string: '#0a3069',
      number: '#0550ae', comment: '#6e7781', operator: '#cf222e', punctuation: '#1f2328', meta: '#0550ae', invalid: '#82071e'
    }
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    mode: 'light',
    source: { url: 'https://github.com/microsoft/vscode/blob/0132168df99ab8830a1eb158b1a5e8242f3e94ff/extensions/theme-solarized-light/themes/solarized-light-color-theme.json', license: 'MIT', copyright: 'Copyright (c) 2015 - present Microsoft Corporation; Copyright (c) 2015 Colorsublime.com' },
    ui: {
      bg: '#fdf6e3', surface: '#eee8d5', 'surface-2': '#eae0c0', 'surface-3': '#dfca88', border: '#ddd6c1', 'border-soft': '#eae0c0', 'border-focused': '#b49471',
      text: '#657b83', muted: '#8f9b9a', faint: '#93a1a1', accent: '#b58900', 'accent-hover': '#9a7500', 'text-on-accent': '#002b36',
      green: '#859900', 'green-surface': '#eeebc7', 'green-border': '#c7cc7d', amber: '#b58900', 'amber-surface': '#f4e9c7',
      danger: '#dc322f', 'danger-surface': '#f9decd', 'danger-strong': '#c12c29', 'danger-highlight': '#cf2f2c', 'danger-text': '#b72a27'
    },
    terminal: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    },
    editor: {
      background: '#fdf6e3', foreground: '#657b83', gutterBackground: '#fdf6e3', gutterForeground: '#237893', gutterBorder: '#eae0c0', activeLine: '#eee8d599', activeLineGutter: '#eee8d5',
      selection: '#eee8d5', focus: '#b49471', cursor: '#657b83', panelBackground: '#eee8d5', tooltipBackground: '#ccc4b0', tooltipBorder: '#ddd6c1',
      keyword: '#859900', variable: '#268bd2', function: '#268bd2', property: '#859900', type: '#cb4b16', string: '#2aa198',
      number: '#d33682', comment: '#93a1a1', operator: '#859900', punctuation: '#657b83', meta: '#93a1a1', invalid: '#dc322f'
    }
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    mode: 'light',
    source: { url: 'https://github.com/catppuccin/zed/blob/0ec5fee4acefadc5baef03a5085adace19fc852f/themes/catppuccin-mauve.json', license: 'MIT', copyright: 'Copyright (c) 2021 Catppuccin' },
    ui: {
      bg: '#eff1f5', surface: '#e6e9ef', 'surface-2': '#ccd0da', 'surface-3': '#dee1e9', border: '#ccd0da', 'border-soft': '#e7e2f5', 'border-focused': '#7287fd',
      text: '#4c4f69', muted: '#5c5f77', faint: '#acb0be', accent: '#8839ef', 'accent-hover': '#7431cb', 'text-on-accent': '#eff1f5',
      green: '#40a02b', 'green-surface': '#dae7dc', 'green-border': '#40a02b', amber: '#df8e1d', 'amber-surface': '#ede5db',
      danger: '#d20f39', 'danger-surface': '#ebd6de', 'danger-strong': '#b80d32', 'danger-highlight': '#c60e36', 'danger-text': '#af0c2f'
    },
    terminal: {
      background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5', selectionBackground: '#7c7f934d',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#de293e', brightGreen: '#49af3d', brightYellow: '#eea02d', brightBlue: '#456eff', brightMagenta: '#fe85d8', brightCyan: '#2d9fa8', brightWhite: '#bcc0cc'
    },
    editor: {
      background: '#eff1f5', foreground: '#4c4f69', gutterBackground: '#eff1f5', gutterForeground: '#8c8fa1', gutterBorder: '#e7e2f5', activeLine: '#4c4f6912', activeLineGutter: '#e3e6eb',
      selection: '#7c7f934d', focus: '#7287fd', cursor: '#dc8a78', panelBackground: '#e6e9ef', tooltipBackground: '#e6e9ef', tooltipBorder: '#ccd0da',
      keyword: '#8839ef', variable: '#4c4f69', function: '#1e66f5', property: '#7287fd', type: '#df8e1d', string: '#40a02b',
      number: '#fe640b', comment: '#7c7f93', operator: '#04a5e5', punctuation: '#7c7f93', meta: '#df8e1d', invalid: '#d20f39'
    }
  },
  {
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    mode: 'light',
    source: { url: 'https://github.com/rose-pine/zed/blob/b77535f1560bc141a933b66ba5a56b44b273cf08/themes/rose-pine-dawn.json', license: 'MIT', copyright: 'Copyright (c) Rosé Pine' },
    ui: {
      bg: '#faf4ed', surface: '#faf4ed', 'surface-2': '#f2e9e1', 'surface-3': '#cecacd', border: '#dfdad9', 'border-soft': '#cecacd', 'border-focused': '#fffaf3',
      text: '#575279', muted: '#797593', faint: '#9893a5', accent: '#56949f', 'accent-hover': '#497e87', 'text-on-accent': '#fffaf3',
      green: '#56949f', 'green-surface': '#f4ede8', 'green-border': '#56949f', amber: '#ea9d34', 'amber-surface': '#f4ede8',
      danger: '#b4637a', 'danger-surface': '#f4ede8', 'danger-strong': '#9e576b', 'danger-highlight': '#a95d73', 'danger-text': '#965265'
    },
    terminal: {
      background: '#faf4ed', foreground: '#575279', cursor: '#575279', cursorAccent: '#faf4ed', selectionBackground: '#57527922',
      black: '#f4ede8', red: '#b4637a', green: '#286983', yellow: '#ea9d34', blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e', white: '#575279',
      brightBlack: '#797593', brightRed: '#b4637a', brightGreen: '#286983', brightYellow: '#ea9d34', brightBlue: '#56949f', brightMagenta: '#907aa9', brightCyan: '#d7827e', brightWhite: '#575279'
    },
    editor: {
      background: '#faf4ed', foreground: '#575279', gutterBackground: '#faf4ed', gutterForeground: '#9893a5', gutterBorder: '#cecacd', activeLine: '#fffaf399', activeLineGutter: '#fffaf3',
      selection: '#57527922', focus: '#fffaf3', cursor: '#575279', panelBackground: '#faf4ed', tooltipBackground: '#fffaf3', tooltipBorder: '#dfdad9',
      keyword: '#286983', variable: '#575279', function: '#d7827e', property: '#907aa9', type: '#56949f', string: '#ea9d34',
      number: '#d7827e', comment: '#9893a5', operator: '#797593', punctuation: '#797593', meta: '#907aa9', invalid: '#b4637a'
    }
  },
  {
    id: 'tokyo-night-day',
    label: 'Tokyo Night Day',
    mode: 'light',
    source: { url: 'https://github.com/folke/tokyonight.nvim/blob/c301092738c0b01c509a37c1266c470531f54568/extras/lua/tokyonight_day.lua', license: 'Apache-2.0', copyright: 'Folke Lemaitre (tokyonight.nvim author); the upstream LICENSE has no copyright line' },
    ui: {
      bg: '#e1e2e7', surface: '#d0d5e3', 'surface-2': '#c4c8da', 'surface-3': '#b3b8d1', border: '#b4b5b9', 'border-soft': '#c4c8da', 'border-focused': '#4094a3',
      text: '#3760bf', muted: '#6172b0', faint: '#848cb5', accent: '#2e7de9', 'accent-hover': '#3760bf', 'text-on-accent': '#ffffff',
      green: '#4197a4', 'green-surface': '#b7ced5', 'green-border': '#99c0c9', amber: '#8c6c3e', 'amber-surface': '#d7d4d2',
      danger: '#c64343', 'danger-surface': '#dababe', 'danger-strong': '#ae3b3b', 'danger-highlight': '#ba3f3f', 'danger-text': '#a53838'
    },
    terminal: {
      background: '#e1e2e7', foreground: '#3760bf', cursor: '#3760bf', cursorAccent: '#e1e2e7', selectionBackground: '#b7c1e3',
      black: '#b4b5b9', red: '#f52a65', green: '#587539', yellow: '#8c6c3e', blue: '#2e7de9', magenta: '#9854f1', cyan: '#007197', white: '#6172b0',
      brightBlack: '#a1a6c5', brightRed: '#ff4774', brightGreen: '#5c8524', brightYellow: '#a27629', brightBlue: '#358aff', brightMagenta: '#a463ff', brightCyan: '#007ea8', brightWhite: '#3760bf'
    },
    editor: {
      background: '#e1e2e7', foreground: '#3760bf', gutterBackground: '#e1e2e7', gutterForeground: '#a8aecb', gutterBorder: '#c4c8da', activeLine: '#c4c8da99', activeLineGutter: '#c4c8da',
      selection: '#b7c1e3', focus: '#4094a3', cursor: '#3760bf', panelBackground: '#d0d5e3', tooltipBackground: '#d0d5e3', tooltipBorder: '#4094a3',
      keyword: '#7847bd', variable: '#3760bf', function: '#2e7de9', property: '#387068', type: '#188092', string: '#587539',
      number: '#b15c00', comment: '#848cb5', operator: '#006a83', punctuation: '#6172b0', meta: '#007197', invalid: '#c64343'
    }
  },
  {
    id: 'everforest-light',
    label: 'Everforest Light',
    mode: 'light',
    source: { url: 'https://github.com/sainnhe/everforest-vscode/blob/b039b30727868d77108ec85f0be66e6d80a9bc1f/themes/everforest-light.json', license: 'MIT', copyright: 'Copyright (c) 2020 sainnhe' },
    ui: {
      bg: '#fdf6e3', surface: '#fdf6e3', 'surface-2': '#f1ecd7', 'surface-3': '#f1ecd7', border: '#efebd4', 'border-soft': '#f1ecd7', 'border-focused': '#93b259',
      text: '#5c6a72', muted: '#879686', faint: '#a4ad9e', accent: '#8da101', 'accent-hover': '#788901', 'text-on-accent': '#fdf6e3',
      green: '#8da101', 'green-surface': '#efecc8', 'green-border': '#cad07d', amber: '#dfa000', 'amber-surface': '#f9ecc7',
      danger: '#f85552', 'danger-surface': '#fce2d1', 'danger-strong': '#da4b48', 'danger-highlight': '#e9504d', 'danger-text': '#c24240'
    },
    terminal: {
      background: '#fdf6e3', foreground: '#5c6a72', cursor: '#5c6a72', cursorAccent: '#fdf6e3', selectionBackground: '#e6e2cca0',
      black: '#5c6a72', red: '#f85552', green: '#8da101', yellow: '#dfa000', blue: '#3a94c5', magenta: '#df69ba', cyan: '#35a77c', white: '#939f91',
      brightBlack: '#5c6a72', brightRed: '#f85552', brightGreen: '#8da101', brightYellow: '#dfa000', brightBlue: '#3a94c5', brightMagenta: '#df69ba', brightCyan: '#35a77c', brightWhite: '#f4f0d9'
    },
    editor: {
      background: '#fdf6e3', foreground: '#5c6a72', gutterBackground: '#fdf6e3', gutterForeground: '#c5c8b8', gutterBorder: '#f1ecd7', activeLine: '#efebd470', activeLineGutter: '#f7f1dc',
      selection: '#e6e2cca0', focus: '#93b259', cursor: '#5c6a72', panelBackground: '#fdf6e3', tooltipBackground: '#f4f0d9', tooltipBorder: '#e6e2cc',
      keyword: '#f85552', variable: '#5c6a72', function: '#8da101', property: '#f57d26', type: '#35a77c', string: '#dfa000',
      number: '#df69ba', comment: '#939f91', operator: '#f57d26', punctuation: '#5c6a72', meta: '#dfa000', invalid: '#f85552'
    }
  },
  {
    id: 'vscode-light-modern',
    label: 'Light Modern',
    mode: 'light',
    source: { url: 'https://github.com/microsoft/vscode/blob/ab8f31f0c0b1a4dd86d8dbee1248542f5806574d/extensions/theme-defaults/themes/light_modern.json', license: 'MIT', copyright: 'Copyright (c) 2015 - present Microsoft Corporation' },
    ui: {
      bg: '#ffffff', surface: '#f8f8f8', 'surface-2': '#f2f2f2', 'surface-3': '#e8e8e8', border: '#e5e5e5', 'border-soft': '#f2f2f2', 'border-focused': '#005fb8',
      text: '#3b3b3b', muted: '#616161', faint: '#6e7681', accent: '#005fb8', 'accent-hover': '#0258a8', 'text-on-accent': '#ffffff',
      green: '#587c0c', 'green-surface': '#ebefe1', 'green-border': '#b4c491', amber: '#bf8803', 'amber-surface': '#f7f1e0',
      danger: '#f85149', 'danger-surface': '#feeae9', 'danger-strong': '#ee0000', 'danger-highlight': '#e94c45', 'danger-text': '#ee0000'
    },
    terminal: {
      background: '#f8f8f8', foreground: '#3b3b3b', cursor: '#005fb8', cursorAccent: '#f8f8f8', selectionBackground: '#add6ff',
      black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#a5a5a5'
    },
    editor: {
      background: '#ffffff', foreground: '#3b3b3b', gutterBackground: '#ffffff', gutterForeground: '#6e7681', gutterBorder: '#f2f2f2', activeLine: '#eeeeee99', activeLineGutter: '#eeeeee',
      selection: '#add6ff', focus: '#005fb8', cursor: '#000000', panelBackground: '#f8f8f8', tooltipBackground: '#f8f8f8', tooltipBorder: '#e5e5e5',
      keyword: '#af00db', variable: '#001080', function: '#795e26', property: '#0451a5', type: '#267f99', string: '#a31515',
      number: '#098658', comment: '#008000', operator: '#000000', punctuation: '#3b3b3b', meta: '#e50000', invalid: '#cd3131'
    }
  }
]
