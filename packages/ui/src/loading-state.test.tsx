import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createRef } from "react";
import { compile } from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { LoaderGrid, LoadingState, useElapsedTimer } from "./loading-state.js";
import { mountShadowApp } from "./test/shadow-app.js";

afterEach(() => {
  cleanup();
  rs.useRealTimers();
  document.body.innerHTML = "";
});

describe("LoadingState", () => {
  it("renders as role='status' with default label 'Churning' and a live elapsed timer", () => {
    render(<LoadingState />);

    const status = screen.getByRole("status");
    expect(status).toBeDefined();
    expect(status.getAttribute("data-variant")).toBe("Drive");
    expect(screen.getByText("Churning")).toBeDefined();
    expect(screen.getByText("0.0s")).toBeDefined();
  });

  it("renders 9 pixel grid cells inside an aria-hidden grid", () => {
    const { container } = render(<LoadingState />);

    const grid = container.querySelector('[data-slot="loader-grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-hidden")).toBe("true");

    const cells = container.querySelectorAll('[data-slot="loader-grid-cell"]');
    expect(cells.length).toBe(9);
  });

  it("renders square cells with system theme color (bg-primary) by default", () => {
    const { container } = render(<LoadingState variant="Drive" />);

    const cells = container.querySelectorAll('[data-slot="loader-grid-cell"]');
    expect(cells[0]?.className).not.toContain("rounded-full");
    expect(cells[0]?.className).toContain("bg-primary");
    expect(cells[0]?.className).toContain("size-1");

    const label = container.querySelector('[data-slot="loading-state-label"]') as HTMLElement;
    expect(label.style.backgroundImage).toContain("var(--primary)");
  });

  it("applies rounded-full cells for Dots variant", () => {
    const { container } = render(<LoadingState variant="Dots" />);

    const cells = container.querySelectorAll('[data-slot="loader-grid-cell"]');
    for (const cell of cells) {
      expect(cell.className).toContain("rounded-full");
    }
  });

  it("dims the center cell in the Orbit variant", () => {
    const { container } = render(<LoadingState variant="Orbit" />);

    const cells = container.querySelectorAll('[data-slot="loader-grid-cell"]');
    expect(cells.length).toBe(9);

    // Center cell (index 4) should have opacity 0.07 and animation: none
    const centerCell = cells[4] as HTMLElement;
    expect(centerCell.style.opacity).toBe("0.07");
    expect(centerCell.style.animation).toBe("none");

    // Perimeter cells should have pixel-on animation
    const cornerCell = cells[0] as HTMLElement;
    expect(cornerCell.style.opacity).toBe("0.15");
    expect(cornerCell.style.animation).toContain("rome-pixel-on 950ms");
  });

  it("takes a caller-provided label", () => {
    render(<LoadingState label="Indexing vector store" />);

    expect(screen.getByText("Indexing vector store")).toBeDefined();
    expect(screen.queryByText("Churning")).toBeNull();
  });

  it("takes a custom aria-label when provided", () => {
    render(<LoadingState ariaLabel="Long-running indexing operation" />);

    const status = screen.getByRole("status", {
      name: "Long-running indexing operation",
    });
    expect(status).toBeDefined();
  });

  it("omits the elapsed timer entirely when elapsed={false}", () => {
    const { container } = render(<LoadingState elapsed={false} />);

    expect(container.querySelector('[data-slot="loading-state-elapsed"]')).toBeNull();
  });
  it("forwards className and ref to the root element", () => {
    const ref = createRef<HTMLDivElement>();
    render(<LoadingState ref={ref} className="custom-loader-class" />);

    expect(ref.current).not.toBeNull();
    expect(ref.current?.classList.contains("custom-loader-class")).toBe(true);
  });

  it("includes motion-reduce:animate-none on animated elements for reduced motion", () => {
    rs.useFakeTimers();
    const { container } = render(<LoadingState />);

    const label = container.querySelector('[data-slot="loading-state-label"]');
    expect(label?.className).toContain("motion-reduce:animate-none!");

    const cell = container.querySelector('[data-slot="loader-grid-cell"]');
    expect(cell?.className).toContain("motion-reduce:animate-none!");
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("0.1s")).toBeDefined();
  });

  it("renders inside a shadow root under theme scope", () => {
    const { appBody, mountRoot } = mountShadowApp();
    appBody.classList.add("dark");

    render(<LoadingState />, { container: mountRoot });

    const status = mountRoot.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(appBody.contains(status)).toBe(true);
    expect(document.body.querySelector('[role="status"]')).toBeNull();
  });

  it("omits the label slot without a fallback while keeping ariaLabel, animation and timer", () => {
    rs.useFakeTimers();
    const { container, rerender } = render(<LoadingState showLabel={false} ariaLabel="正在处理" />);

    expect(screen.getByRole("status", { name: "正在处理" })).toBeDefined();
    expect(container.querySelector('[data-slot="loading-state-label"]')).toBeNull();
    expect(screen.queryByText("Churning")).toBeNull();
    const cell = container.querySelector('[data-slot="loader-grid-cell"]') as HTMLElement;
    expect(cell.style.animation).toContain("rome-pixel-on 650ms");
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("0.1s")).toBeDefined();

    rerender(<LoadingState label="正在读取原始状态…" showLabel={false} ariaLabel="正在处理" />);
    expect(container.querySelector('[data-slot="loading-state-label"]')).toBeNull();
    expect(screen.queryByText("正在读取原始状态…")).toBeNull();

    rerender(<LoadingState label="正在读取原始状态…" ariaLabel="正在处理" />);
    expect(screen.getByText("正在读取原始状态…")).toBeDefined();
    expect(screen.queryByText("Churning")).toBeNull();
  });

  it("applies labelClassName only to the label without changing default styles", () => {
    const { container, rerender } = render(<LoadingState />);
    const status = screen.getByRole("status");
    const label = container.querySelector('[data-slot="loading-state-label"]') as HTMLElement;
    const grid = container.querySelector('[data-slot="loader-grid"]') as HTMLElement;
    const timer = container.querySelector('[data-slot="loading-state-elapsed"]') as HTMLElement;
    const rootClass = status.className;
    const labelStyle = label.getAttribute("style");
    const gridClass = grid.className;
    const timerClass = timer.className;

    expect(label.className).toBe(
      "bg-clip-text text-badge text-transparent motion-reduce:animate-none! motion-reduce:text-muted-foreground",
    );
    expect(rootClass).toBe("flex w-fit items-center gap-2");

    rerender(<LoadingState labelClassName="min-w-0 truncate" />);
    expect(label.classList.contains("truncate")).toBe(true);
    expect(label.classList.contains("min-w-0")).toBe(true);
    expect(label.classList.contains("motion-reduce:animate-none!")).toBe(true);
    expect(label.getAttribute("style")).toBe(labelStyle);
    expect(status.className).toBe(rootClass);
    expect(grid.className).toBe(gridClass);
    expect(timer.className).toBe(timerClass);

    rerender(<LoadingState />);
    expect(label.classList.contains("truncate")).toBe(false);
  });

  it("forwards native props but consumes all LoadingState options", () => {
    rs.useFakeTimers();
    const onClick = rs.fn();
    const ref = createRef<HTMLDivElement>();
    render(
      <LoadingState
        ref={ref}
        id="native-loading"
        title="Native title"
        tabIndex={0}
        data-testid="native-loading"
        onClick={onClick}
        label="原始状态"
        showLabel={false}
        labelClassName="truncate"
        startedAt={Date.now() - 1000}
        elapsed={false}
        variant="Dots"
        ariaLabel="Accessible state"
        className="custom-loader"
      />,
    );

    const status = screen.getByTestId("native-loading");
    expect(ref.current).toBe(status);
    expect(status.id).toBe("native-loading");
    expect(status.title).toBe("Native title");
    expect(status.tabIndex).toBe(0);
    expect(status.classList.contains("custom-loader")).toBe(true);
    expect(status.getAttribute("data-slot")).toBe("loading-state");
    expect(status.getAttribute("data-variant")).toBe("Dots");
    expect(status.getAttribute("aria-label")).toBe("Accessible state");
    for (const prop of [
      "label",
      "showlabel",
      "labelclassname",
      "startedat",
      "elapsed",
      "variant",
      "arialabel",
    ]) {
      expect(status.hasAttribute(prop)).toBe(false);
    }
    fireEvent.click(status);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(rs.getTimerCount()).toBe(0);
  });
});

describe("LoaderGrid standalone", () => {
  it("renders standalone with default Drive pattern", () => {
    const { container } = render(<LoaderGrid />);

    const grid = container.querySelector('[data-slot="loader-grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-hidden")).toBe("true");

    const cells = container.querySelectorAll('[data-slot="loader-grid-cell"]');
    expect(cells.length).toBe(9);
  });

  it("renders with custom variant='Dots'", () => {
    const { container } = render(<LoaderGrid variant="Dots" />);

    const cells = container.querySelectorAll('[data-slot="loader-grid-cell"]');
    expect(cells[0]?.className).toContain("rounded-full");
  });

  it("forwards ref and DOM attributes", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<LoaderGrid ref={ref} className="my-grid" id="test-grid" />);

    expect(ref.current).not.toBeNull();
    expect(ref.current?.id).toBe("test-grid");
    expect(ref.current?.classList.contains("my-grid")).toBe(true);
  });
});

describe("useElapsedTimer", () => {
  function TimerTestComponent({ enabled }: { enabled?: boolean }) {
    const elapsed = useElapsedTimer(enabled);
    return <span data-testid="elapsed">{elapsed}</span>;
  }

  it("renders initial 0.0s count", () => {
    render(<TimerTestComponent />);
    expect(screen.getByTestId("elapsed").textContent).toBe("0.0s");
  });

  it("does not start interval when enabled is false", () => {
    rs.useFakeTimers();
    render(<TimerTestComponent enabled={false} />);
    expect(screen.getByTestId("elapsed").textContent).toBe("0.0s");
    expect(rs.getTimerCount()).toBe(0);
  });
});

describe("useElapsedTimer", () => {
  it("tracks wall-clock elapsed time while enabled", () => {
    rs.useFakeTimers();
    const timer = renderHook(({ enabled }) => useElapsedTimer(enabled), {
      initialProps: { enabled: true },
    });
    expect(timer.result.current).toBe("0.0s");
    act(() => rs.advanceTimersByTime(100));
    expect(timer.result.current).toBe("0.1s");
    act(() => rs.advanceTimersByTime(59_900));
    expect(timer.result.current).toBe("1m 0.0s");
    act(() => rs.advanceTimersByTime(1200));
    expect(timer.result.current).toBe("1m 1.2s");

    timer.rerender({ enabled: false });
    expect(rs.getTimerCount()).toBe(0);
    act(() => rs.advanceTimersByTime(5000));
    expect(timer.result.current).toBe("1m 1.2s");
    timer.rerender({ enabled: true });
    expect(rs.getTimerCount()).toBe(1);
    expect(timer.result.current).toBe("1m 6.2s");
    act(() => rs.advanceTimersByTime(100));
    expect(timer.result.current).toBe("1m 6.3s");
    timer.unmount();
    expect(rs.getTimerCount()).toBe(0);
  });

  it("does not drift when system time advances in background", () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    const { result, unmount } = renderHook(() => useElapsedTimer());
    rs.setSystemTime(new Date("2026-10-10T13:00:00Z"));
    act(() => rs.advanceTimersByTime(100));
    expect(result.current).toBe("60m 0.1s");
    unmount();
    expect(rs.getTimerCount()).toBe(0);
  });
});

describe("LoadingState wall-clock elapsed time", () => {
  const now = Date.UTC(2026, 9, 10, 12);

  beforeEach(() => {
    rs.useFakeTimers();
    rs.setSystemTime(now);
  });

  it.each([
    [59_940, "59.9s"],
    [59_960, "1m 0.0s"],
    [119_940, "1m 59.9s"],
    [119_960, "2m 0.0s"],
  ] as const)("rounds %s milliseconds before splitting minutes (%s)", (milliseconds, expected) => {
    render(<LoadingState startedAt={now - milliseconds} />);
    expect(screen.getByText(expected)).toBeDefined();
    expect(screen.queryByText(/m 60\.0s/)).toBeNull();
  });

  it("accepts zero as a valid epoch timestamp", () => {
    rs.setSystemTime(1300);
    render(<LoadingState startedAt={0} />);
    expect(screen.getByText("1.3s")).toBeDefined();
  });

  it("renders elapsed time from a supplied epoch timestamp immediately", () => {
    render(<LoadingState startedAt={now - 12_500} />);
    expect(screen.getByText("12.5s")).toBeDefined();
    expect(rs.getTimerCount()).toBe(1);
  });

  it("keeps the same origin across rerenders and remounts", () => {
    const startedAt = now - 12_500;
    const { rerender, unmount } = render(<LoadingState startedAt={startedAt} />);
    rs.setSystemTime(now + 500);
    rerender(<LoadingState startedAt={startedAt} label="原文状态" />);
    expect(screen.getByText("13.0s")).toBeDefined();
    expect(screen.getByText("原文状态")).toBeDefined();
    expect(rs.getTimerCount()).toBe(1);

    unmount();
    expect(rs.getTimerCount()).toBe(0);
    rs.setSystemTime(now + 1500);
    render(<LoadingState startedAt={startedAt} />);
    expect(screen.getByText("14.0s")).toBeDefined();
    expect(rs.getTimerCount()).toBe(1);
  });

  it("updates when the origin changes and replaces rather than duplicates the interval", () => {
    const { rerender, unmount } = render(<LoadingState startedAt={now - 20_000} />);
    expect(screen.getByText("20.0s")).toBeDefined();
    rerender(<LoadingState startedAt={now - 6500} />);
    expect(screen.getByText("6.5s")).toBeDefined();
    expect(rs.getTimerCount()).toBe(1);
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("6.6s")).toBeDefined();
    unmount();
    expect(rs.getTimerCount()).toBe(0);
  });

  it("clamps future origins to zero until the wall clock passes them", () => {
    render(<LoadingState startedAt={now + 1000} />);
    expect(screen.getByText("0.0s")).toBeDefined();
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("0.0s")).toBeDefined();
    rs.setSystemTime(now + 1000);
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("0.1s")).toBeDefined();
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
  ])("falls back to mount time for invalid origin %s", (startedAt) => {
    render(<LoadingState startedAt={startedAt} />);
    expect(screen.getByText("0.0s")).toBeDefined();
    rs.setSystemTime(now + 60_000);
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("1m 0.1s")).toBeDefined();
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });

  it("catches up after a delayed tick using real clock difference and minute formatting", () => {
    render(<LoadingState startedAt={now} />);
    rs.setSystemTime(now + 65_000);
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("1m 5.1s")).toBeDefined();
    rs.setSystemTime(now - 1000);
    act(() => rs.advanceTimersByTime(100));
    expect(screen.getByText("0.0s")).toBeDefined();
  });

  it.each([
    undefined,
    now - 1000,
  ])("holds no interval while elapsed is disabled (origin %s)", (startedAt) => {
    const { container, rerender, unmount } = render(
      <LoadingState startedAt={startedAt} elapsed={false} />,
    );
    expect(container.querySelector('[data-slot="loading-state-elapsed"]')).toBeNull();
    expect(rs.getTimerCount()).toBe(0);
    rerender(<LoadingState startedAt={now - 2000} elapsed={false} />);
    expect(rs.getTimerCount()).toBe(0);

    rerender(<LoadingState startedAt={startedAt} />);
    expect(rs.getTimerCount()).toBe(1);
    rerender(<LoadingState startedAt={startedAt} elapsed={false} />);
    expect(container.querySelector('[data-slot="loading-state-elapsed"]')).toBeNull();
    expect(rs.getTimerCount()).toBe(0);
    rerender(<LoadingState startedAt={startedAt} />);
    expect(rs.getTimerCount()).toBe(1);
    unmount();
    expect(rs.getTimerCount()).toBe(0);
  });

  it("cleans up when switching between tick counting and wall-clock modes", () => {
    const { result, rerender, unmount } = renderHook(
      ({ startedAt }: { startedAt?: number }) => useElapsedTimer(true, startedAt),
      { initialProps: { startedAt: undefined as number | undefined } },
    );
    act(() => rs.advanceTimersByTime(200));
    expect(result.current).toBe("0.2s");

    rerender({ startedAt: now - 1000 });
    expect(result.current).toBe("1.2s");
    expect(rs.getTimerCount()).toBe(1);
    act(() => rs.advanceTimersByTime(100));
    expect(result.current).toBe("1.3s");

    rerender({ startedAt: NaN });
    expect(result.current).toBe("0.3s");
    expect(rs.getTimerCount()).toBe(1);
    act(() => rs.advanceTimersByTime(100));
    expect(result.current).toBe("0.4s");
    rerender({ startedAt: undefined });
    expect(rs.getTimerCount()).toBe(1);
    unmount();
    expect(rs.getTimerCount()).toBe(0);
  });

  it("re-enables wall-clock measurement without pausing the supplied origin", () => {
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useElapsedTimer(enabled, now - 1000),
      { initialProps: { enabled: true } },
    );
    expect(result.current).toBe("1.0s");
    rerender({ enabled: false });
    expect(rs.getTimerCount()).toBe(0);
    rs.setSystemTime(now + 5000);
    rerender({ enabled: true });
    expect(result.current).toBe("6.0s");
    expect(rs.getTimerCount()).toBe(1);
    act(() => rs.advanceTimersByTime(100));
    expect(result.current).toBe("6.1s");
    unmount();
    expect(rs.getTimerCount()).toBe(0);
  });
});

describe("LoadingState motion cascade", () => {
  it.each([
    "loader-grid-cell",
    "loading-state-label",
  ])("emits a reduced-motion override strong enough for the inline animation on %s", async (slot) => {
    const { container } = render(<LoadingState />);
    const element = container.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
    expect(element.style.animation).not.toBe("none");

    const require = createRequire(join(import.meta.dirname, "loading-state.test.tsx"));
    const compiler = await compile(
      '@import "tailwindcss";\n' + readFileSync(join(import.meta.dirname, "styles.css"), "utf8"),
      {
        base: import.meta.dirname,
        loadStylesheet: async (id, base) => {
          const path =
            id === "tailwindcss"
              ? require.resolve("tailwindcss/index.css")
              : id.startsWith(".")
                ? resolve(base, id)
                : require.resolve(id);
          return { path, base: dirname(path), content: readFileSync(path, "utf8") };
        },
      },
    );
    const css = compiler.build(
      [...element.classList].filter((name) => name.startsWith("motion-reduce:")),
    );
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
    if (slot === "loading-state-label") {
      expect(css).toContain("color: var(--muted-foreground)");
    }
    if (slot === "loader-grid-cell") {
      expect(css).toContain("opacity: 60% !important");
    }
  });
});

describe("LoadingState announcements", () => {
  it("keeps elapsed ticks out of the status announcement while preserving the status text", () => {
    rs.useFakeTimers();
    const { container, rerender } = render(
      <LoadingState label="正在读取原始状态…" ariaLabel="读取状态" />,
    );
    const timer = container.querySelector('[data-slot="loading-state-elapsed"]');
    const label = container.querySelector('[data-slot="loading-state-label"]');
    expect(timer?.getAttribute("aria-hidden")).toBe("true");
    expect(label?.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByRole("status", { name: "读取状态" })).toBeDefined();
    act(() => rs.advanceTimersByTime(500));
    expect(timer?.textContent).toBe("0.5s");
    expect(label?.textContent).toBe("正在读取原始状态…");

    rerender(<LoadingState label="正在使用某应用" ariaLabel="应用状态" />);
    expect(label?.textContent).toBe("正在使用某应用");
    expect(screen.getByRole("status", { name: "应用状态" })).toBeDefined();
    expect(timer?.getAttribute("aria-hidden")).toBe("true");
  });

  it("preserves caller-provided native live-region attributes", () => {
    render(<LoadingState elapsed={false} aria-live="off" aria-atomic={false} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("off");
    expect(status.getAttribute("aria-atomic")).toBe("false");
  });
});
