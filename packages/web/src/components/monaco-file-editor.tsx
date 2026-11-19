import { useMemo } from "react";
import Editor, { type BeforeMount, type OnChange, type OnMount } from "@monaco-editor/react";
import { useTheme } from "@/hooks/use-theme";

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  // JS/TS
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  // JSON & config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  env: "ini",
  // Markdown / text
  md: "markdown",
  mdx: "markdown",
  txt: "plaintext",
  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  // Backend langs
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  pl: "perl",
  r: "r",
  scala: "scala",
  dart: "dart",
  // Data / query
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
  svg: "xml",
  // Misc
  dockerfile: "dockerfile",
  makefile: "makefile",
  vue: "html",
};

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".env": "ini",
  ".gitignore": "plaintext",
  ".prettierrc": "json",
  ".eslintrc": "json",
};

function detectLanguage(path: string): string {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (FILENAME_TO_LANGUAGE[base]) return FILENAME_TO_LANGUAGE[base];
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) return "plaintext";
  const ext = base.slice(dotIdx + 1);
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

interface MonacoFileEditorProps {
  path: string;
  /**
   * The editor model's own key, when it must differ from `path`. Monaco keeps
   * one model per key and disposes it when an editor using it unmounts, so two
   * editors open on one file at once each need their own.
   */
  modelPath?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  readOnly?: boolean;
}

export function MonacoFileEditor({
  path,
  modelPath,
  value,
  onBlur,
  onChange,
  readOnly,
}: MonacoFileEditorProps) {
  const { resolved } = useTheme();
  const language = useMemo(() => detectLanguage(path), [path]);
  const theme = resolved === "dark" ? "vs-dark" : "vs";

  return (
    <Editor
      path={modelPath ?? path}
      language={language}
      value={value}
      theme={theme}
      beforeMount={
        ((monaco) => {
          monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
          });
          monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
          });
        }) satisfies BeforeMount
      }
      onChange={((next) => onChange(next ?? "")) satisfies OnChange}
      onMount={
        ((editor) => {
          const disposable = editor.onDidBlurEditorText(() => onBlur?.());
          editor.onDidDispose(() => disposable.dispose());
        }) satisfies OnMount
      }
      options={{
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        // Monaco only accepts a numeric pixel size, so it cannot read a CSS typography role.
        fontSize: 13,
        tabSize: 2,
        renderWhitespace: "selection",
        smoothScrolling: true,
      }}
    />
  );
}
