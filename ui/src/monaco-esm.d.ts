// Type declarations for Monaco editor ESM sub-path imports.
// The ESM API-only entrypoint has the same API surface as "monaco-editor"
// but avoids bundling all built-in language contributions.
declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}
