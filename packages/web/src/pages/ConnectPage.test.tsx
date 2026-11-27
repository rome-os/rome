// @rstest-environment jsdom
import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { beginInstanceEnroll } from "@/lib/instance-enroll";
import ConnectPage from "./ConnectPage";

rs.mock("@/lib/instance-enroll", { spy: true });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderConnect(url = "/connect") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ConnectPage />
    </MemoryRouter>,
  );
}

it("starts enrollment once on rapid clicks and allows retry after a failure", async () => {
  let finish!: (response: Response) => void;
  const request = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetchSpy = rs
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => request)
    .mockImplementation(async () => Response.json({}, { status: 503 }));
  renderConnect();
  const button = screen.getByRole("button", { name: "Connect to Rome Cloud" });

  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  expect(fetchSpy).toHaveBeenCalledWith(
    "/api/instance/enroll/start",
    expect.objectContaining({ method: "POST" }),
  );
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Opening Rome Cloud…")).toBeTruthy();
  fireEvent.click(button);
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await act(async () => finish(Response.json({}, { status: 503 })));
  expect(screen.getByRole("alert").textContent).toBe(
    "Could not start the connection. Please try again.",
  );
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(button.hasAttribute("aria-disabled")).toBe(false);

  await act(async () => {
    fireEvent.click(button);
  });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("shows the state mismatch message from the callback", () => {
  renderConnect("/connect?enroll=error&reason=state");

  expect(screen.getByRole("alert").textContent).toBe(
    "The sign-in response didn't match this request. Please try again.",
  );
});

it("stays locked after enrollment starts successfully", async () => {
  const fetchSpy = rs
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ authorizeUrl: window.location.href }));
  renderConnect();
  const button = screen.getByRole("button", { name: "Connect to Rome Cloud" });

  await act(async () => {
    fireEvent.click(button);
  });

  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
    "/api/instance/enroll/start",
    expect.objectContaining({ method: "POST" }),
  );
});

it("shows an error and allows retry after enrollment rejects unexpectedly", async () => {
  const { promise, reject } = Promise.withResolvers<never>();
  rs.mocked(beginInstanceEnroll).mockReturnValueOnce(promise);
  const fetchSpy = rs
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({}, { status: 503 }));
  renderConnect();
  const button = screen.getByRole("button", { name: "Connect to Rome Cloud" });

  fireEvent.click(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  await act(async () => reject(new Error("unexpected enrollment failure")));

  expect(screen.getByRole("alert").textContent).toBe(
    "Could not start the connection. Please try again.",
  );
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(button.hasAttribute("aria-disabled")).toBe(false);

  await act(async () => {
    fireEvent.click(button);
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
