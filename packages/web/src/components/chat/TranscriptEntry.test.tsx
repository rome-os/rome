// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { renderFlatEntries } from "@/components/chat/entries";
import { ThemeProvider } from "@/hooks/use-theme";
import { TranscriptEntry } from "./TranscriptEntry";

afterEach(cleanup);

function inTranscript(node: React.ReactNode) {
  return render(
    <ThemeProvider>
      <div data-chat-transcript="">{node}</div>
    </ThemeProvider>,
  );
}

describe("TranscriptEntry", () => {
  it("brings a live entry in once, then shows the same key in place", () => {
    const first = inTranscript(
      <TranscriptEntry entryKey="turn-a:text:0" live kind="bubble">
        <span>live preview</span>
      </TranscriptEntry>,
    );
    const entering = screen.getByText("live preview").parentElement as HTMLElement;
    expect(entering.style.opacity).toBe("0");
    first.unmount();

    inTranscript(
      <TranscriptEntry entryKey="turn-a:text:0" live kind="bubble">
        <span>saved copy</span>
      </TranscriptEntry>,
    );
    const handedOver = screen.getByText("saved copy").parentElement as HTMLElement;
    expect(handedOver.style.opacity).toBe("");
  });

  it("shows an entry of a settled turn in place", () => {
    inTranscript(
      <TranscriptEntry entryKey="turn-b:text:0" live={false} kind="bubble">
        <span>history</span>
      </TranscriptEntry>,
    );
    expect((screen.getByText("history").parentElement as HTMLElement).style.opacity).toBe("");
  });
});

describe("transcript text blocks", () => {
  it("renders each text block as its own bubble in the transcript", () => {
    inTranscript(
      renderFlatEntries(
        [
          { type: "text", content: "first thought", blockIx: 0 },
          { type: "text", content: "final answer", blockIx: 1 },
        ],
        { turnId: "turn-c", transcript: { live: false } },
      ),
    );
    for (const text of ["first thought", "final answer"]) {
      const bubble = screen.getByText(text).closest(".rounded-16");
      expect(bubble?.classList.contains("bg-surface-muted")).toBe(true);
    }
  });

  it("keeps text bare outside the transcript", () => {
    inTranscript(renderFlatEntries([{ type: "text", content: "trace text", blockIx: 0 }]));
    expect(screen.getByText("trace text").closest(".rounded-16")).toBeNull();
  });
});
