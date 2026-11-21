// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@/hooks/use-theme";
import { MonacoFileEditor } from "./monaco-file-editor";

// Monaco keys a model by the editor's `path` and disposes it when an editor
// using it unmounts, so the key the wrapper receives is what matters here.
rs.mock("@monaco-editor/react", () => ({
  default: ({ path, language }: { path: string; language: string }) => (
    <div data-testid="monaco" data-path={path} data-language={language} />
  ),
}));

afterEach(() => cleanup());

function renderEditor(props: { path: string; modelPath?: string }) {
  render(
    <ThemeProvider>
      <MonacoFileEditor {...props} value="" onChange={() => {}} />
    </ThemeProvider>,
  );
  return screen.getByTestId("monaco");
}

describe("MonacoFileEditor model key", () => {
  it("keys the model by the file's path by default", () => {
    const editor = renderEditor({ path: "projects/demo/a.txt" });
    expect(editor.getAttribute("data-path")).toBe("projects/demo/a.txt");
  });

  it("keys it by modelPath when given, and still reads the language from the file", () => {
    const editor = renderEditor({
      path: "projects/demo/a.md",
      modelPath: "single-file/projects/demo/a.md",
    });
    expect(editor.getAttribute("data-path")).toBe("single-file/projects/demo/a.md");
    expect(editor.getAttribute("data-language")).toBe("markdown");
  });
});
