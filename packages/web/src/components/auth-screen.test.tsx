// @rstest-environment jsdom
import { afterEach, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthActionButton } from "./auth-screen";

afterEach(cleanup);

it("blocks duplicate and busy clicks and unlocks once the action settles", async () => {
  let finish!: () => void;
  const action = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onClick = rs.fn(() => action);
  const button = (busy: boolean) => (
    <AuthActionButton busy={busy} busyLabel="Connecting" onClick={onClick}>
      Connect
    </AuthActionButton>
  );
  const { rerender } = render(button(false));
  const control = screen.getByRole("button", { name: "Connect" });

  act(() => {
    fireEvent.click(control);
    fireEvent.click(control);
  });
  expect(onClick).toHaveBeenCalledTimes(1);

  rerender(button(true));
  expect(control.getAttribute("aria-busy")).toBe("true");
  expect(control.getAttribute("aria-disabled")).toBe("true");
  expect(control.hasAttribute("disabled")).toBe(false);
  await act(async () => finish());
  fireEvent.click(control);
  expect(onClick).toHaveBeenCalledTimes(1);

  rerender(button(false));
  fireEvent.click(control);
  expect(onClick).toHaveBeenCalledTimes(2);
});

it("releases the lock synchronously for actions that return no promise", () => {
  const onClick = rs.fn(() => {});
  render(
    <AuthActionButton busy={false} busyLabel="Connecting" onClick={onClick}>
      Connect
    </AuthActionButton>,
  );
  const control = screen.getByRole("button", { name: "Connect" });

  act(() => {
    fireEvent.click(control);
    fireEvent.click(control);
  });
  expect(onClick).toHaveBeenCalledTimes(2);
});

it("unlocks after a rejected action without an unhandled rejection", async () => {
  const { promise, reject } = Promise.withResolvers<void>();
  const onClick = rs.fn(async () => {}).mockReturnValueOnce(promise);
  render(
    <AuthActionButton busy={false} busyLabel="Connecting" onClick={onClick}>
      Connect
    </AuthActionButton>,
  );
  const control = screen.getByRole("button", { name: "Connect" });

  fireEvent.click(control);
  await act(async () => reject(new Error("action failed")));
  await act(async () => {
    fireEvent.click(control);
  });

  expect(onClick).toHaveBeenCalledTimes(2);
});

it("unlocks after an action throws synchronously", () => {
  const error = new Error("action threw");
  const onClick = rs
    .fn(() => {})
    .mockImplementationOnce(() => {
      throw error;
    });
  const reportedErrors: unknown[] = [];
  function onError(event: ErrorEvent) {
    if (event.error !== error) return;
    reportedErrors.push(event.error);
    event.preventDefault();
  }

  render(
    <AuthActionButton busy={false} busyLabel="Connecting" onClick={onClick}>
      Connect
    </AuthActionButton>,
  );
  const control = screen.getByRole("button", { name: "Connect" });
  window.addEventListener("error", onError);
  try {
    fireEvent.click(control);
  } finally {
    window.removeEventListener("error", onError);
  }
  expect(reportedErrors).toEqual([error]);
  expect(onClick).toHaveBeenCalledTimes(1);

  fireEvent.click(control);
  expect(onClick).toHaveBeenCalledTimes(2);
});
