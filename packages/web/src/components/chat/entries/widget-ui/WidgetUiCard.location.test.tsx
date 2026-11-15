// @rstest-environment jsdom
import { locationCardUi } from "@rome/api-types/location-card";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
import { WidgetUiCard } from "./WidgetUiCard";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  Reflect.deleteProperty(navigator, "geolocation");
});

const ui = locationCardUi("To find coffee near you") as never;
/** The card core shows for a turn the guardian's own message started. */
const autoUi = locationCardUi("To find coffee near you", true) as never;

/** The browser's geolocation, answering every read with `answer`. */
function stubGeolocation(answer: { fix?: GeolocationPosition; error?: number }) {
  const getCurrentPosition = rs.fn((ok: PositionCallback, fail?: PositionErrorCallback | null) => {
    if (answer.fix) ok(answer.fix);
    else fail?.({ code: answer.error ?? 2, PERMISSION_DENIED: 1 } as GeolocationPositionError);
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition },
  });
  return getCurrentPosition;
}

function captureEvents() {
  const events: { name: string; context: unknown }[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    events.push(JSON.parse(String(init?.body)));
    return Response.json({ answered: true });
  });
  return events;
}

describe("the share-location card", () => {
  it("reads the position on Share and sends it with the event", async () => {
    const read = stubGeolocation({
      fix: {
        coords: { latitude: 31.23, longitude: 121.47, accuracy: 18 },
        timestamp: 1_800_000_000_000,
      } as GeolocationPosition,
    });
    const events = captureEvents();
    render(<WidgetUiCard widgetId="m1" toolUseId="l1" appId="core" ui={ui} text="" waiting={{}} />);
    expect(await screen.findByText("To find coffee near you")).toBeTruthy();
    // Nothing is read before the guardian presses Share.
    expect(read).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.name).toBe("share-location");
    expect(events[0]?.context).toEqual({
      latitude: 31.23,
      longitude: 121.47,
      accuracy: 18,
      timestamp: 1_800_000_000_000,
    });
  });

  it("says why when the browser refuses, sends nothing, and stays usable", async () => {
    stubGeolocation({ error: 1 });
    const events = captureEvents();
    render(<WidgetUiCard widgetId="m1" toolUseId="l1" appId="core" ui={ui} text="" waiting={{}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(await screen.findByText(/Location access is off/)).toBeTruthy();
    expect(events).toEqual([]);
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows how an answered card ended", async () => {
    const { rerender } = render(
      <WidgetUiCard
        widgetId="m1"
        toolUseId="l1"
        appId="core"
        ui={ui}
        text=""
        waiting={{ result: { status: "shared", accuracyMeters: 18 } }}
      />,
    );
    expect(await screen.findByText("Location shared · ±18 m")).toBeTruthy();
    rerender(
      <WidgetUiCard
        widgetId="m1"
        toolUseId="l1"
        appId="core"
        ui={ui}
        text=""
        waiting={{ result: { dismissed: true } }}
      />,
    );
    expect(await screen.findByText("Not shared")).toBeTruthy();
  });
});

describe("the share-location card where the browser already decided", () => {
  const stubPermission = (state: PermissionState) =>
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state }) },
    });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "permissions");
  });

  it("answers by itself, with no buttons, where the site may read the position", async () => {
    stubPermission("granted");
    stubGeolocation({
      fix: {
        coords: { latitude: 1, longitude: 2, accuracy: 9 },
        timestamp: 5,
      } as GeolocationPosition,
    });
    const events = captureEvents();
    render(
      <WidgetUiCard
        widgetId="auto-1"
        toolUseId="l1"
        appId="core"
        ui={autoUi}
        text=""
        waiting={{}}
      />,
    );
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      name: "share-location",
      context: { latitude: 1, longitude: 2, accuracy: 9, timestamp: 5, auto: true },
    });
    // Before history brings the stored answer, the share just sent shows as one line.
    expect(await screen.findByText("Location shared · ±9 m")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("waits for Share on a card core did not mark, though the site may read the position", async () => {
    stubPermission("granted");
    const read = stubGeolocation({ error: 2 });
    const events = captureEvents();
    render(
      <WidgetUiCard widgetId="auto-3" toolUseId="l1" appId="core" ui={ui} text="" waiting={{}} />,
    );
    expect(await screen.findByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("never shares for an app's card that copies core's, and sends it no position", async () => {
    stubPermission("granted");
    const read = stubGeolocation({
      fix: {
        coords: { latitude: 1, longitude: 2, accuracy: 9 },
        timestamp: 5,
      } as GeolocationPosition,
    });
    const events = captureEvents();
    render(
      <WidgetUiCard
        widgetId="forged-1"
        toolUseId="l1"
        appId="some-app"
        ui={autoUi}
        text=""
        waiting={{}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ name: "share-location" });
    expect(events[0]?.context).not.toHaveProperty("latitude");
    expect(read).not.toHaveBeenCalled();
  });

  it("shows a share it made by itself as one line, with no card", () => {
    render(
      <WidgetUiCard
        widgetId="auto-4"
        toolUseId="l1"
        appId="core"
        ui={autoUi}
        text=""
        waiting={{ result: { status: "shared", accuracyMeters: 9, auto: true } }}
      />,
    );
    expect(screen.getByText("Location shared · ±9 m")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Share your location?")).toBeNull();
  });

  it("says the browser refuses, and keeps Not now", async () => {
    stubPermission("denied");
    const events = captureEvents();
    render(
      <WidgetUiCard widgetId="auto-2" toolUseId="l1" appId="core" ui={ui} text="" waiting={{}} />,
    );
    expect(await screen.findByText(/Location access is off/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(events).toEqual([]);
  });

  it("shows Share and Not now where the browser will ask", async () => {
    stubPermission("prompt");
    const events = captureEvents();
    render(
      <WidgetUiCard widgetId="auto-3" toolUseId="l1" appId="core" ui={ui} text="" waiting={{}} />,
    );
    expect(await screen.findByRole("button", { name: "Share" })).toBeTruthy();
    expect(events).toEqual([]);
  });
});
