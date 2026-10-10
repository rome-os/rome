interface DesktopVncProbe {
  wsUrl: string;
  focusCount: number;
  clipboardPasteFrom: string[];
  sendKey: Array<{
    keysym: number;
    code: string | null;
    down: boolean | null;
  }>;
}

declare global {
  interface Window {
    __desktopVncProbe: DesktopVncProbe;
    __desktopVncRfb: FakeRfb;
  }
}

export default class FakeRfb extends EventTarget {
  viewOnly = false;
  scaleViewport = false;
  clipViewport = false;
  dragViewport = false;
  resizeSession = false;

  constructor(
    private readonly screen: Element,
    wsUrl: string,
  ) {
    super();
    window.__desktopVncProbe = {
      wsUrl,
      focusCount: 0,
      clipboardPasteFrom: [],
      sendKey: [],
    };
    window.__desktopVncRfb = this;

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    canvas.style.width = "640px";
    canvas.style.height = "400px";
    screen.append(canvas);

    queueMicrotask(() => this.dispatchEvent(new Event("connect")));
  }

  focus(): void {
    window.__desktopVncProbe.focusCount += 1;
    if (this.screen instanceof HTMLElement) this.screen.focus();
  }

  blur(): void {
    if (this.screen instanceof HTMLElement) this.screen.blur();
  }

  disconnect(): void {}

  clipboardPasteFrom(text: string): void {
    window.__desktopVncProbe.clipboardPasteFrom.push(text);
  }

  sendKey(keysym: number, code: string | null, down?: boolean): void {
    window.__desktopVncProbe.sendKey.push({
      keysym,
      code: code ?? null,
      down: down ?? null,
    });
  }
}
