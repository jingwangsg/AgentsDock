// Monaco ships no typings for its tokenizer-only entry point, and side-effect
// imports must still resolve under this compiler configuration.
declare module 'monaco-editor/basic-languages/monaco.contribution'
