// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import type { ApprovalRecord, PreviewPayload } from "@/lib/chat-types";
import { ApprovalCard } from "./ApprovalCard";

const mockFetchApproval = rs.hoisted(() => rs.fn());
const mockResolveApproval = rs.hoisted(() => rs.fn());

rs.mock("@/hooks/use-tab-status", () => ({ useTabStatus: rs.fn() }));
rs.mock("@/lib/chat-api", () => ({
  fetchApproval: mockFetchApproval,
  resolveApproval: mockResolveApproval,
}));

const preview = (over: Partial<Extract<PreviewPayload, { kind: "secret_access" }>> = {}) =>
  ({
    kind: "secret_access",
    name: "GITHUB_TOKEN",
    ttlMinutes: 15,
    reason: "Push the release tag",
    title: "Use GITHUB_TOKEN for 15 min",
    summary: "Push the release tag",
    ...over,
  }) as PreviewPayload;

const record = (patch: Partial<ApprovalRecord>): ApprovalRecord => ({
  id: "appr-1",
  status: "pending",
  executionState: null,
  executionError: null,
  ...patch,
});

function mount(
  p: PreviewPayload,
  settled: "fold" | "full" = "fold",
  actionName = "system:vault_apply",
) {
  return render(
    <ApprovalCard
      approvalId="appr-1"
      actionName={actionName}
      preview={p}
      status="pending"
      onResolved={() => {}}
      settled={settled}
    />,
  );
}

/** Answers the one vault call a card makes, and returns what it was asked. */
function mockGrant(status: number, body: unknown) {
  return rs.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const pinField = () => screen.getByLabelText("PIN") as HTMLInputElement;
const allowButton = () => screen.getByRole("button", { name: "Allow 15 min" }) as HTMLButtonElement;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mockFetchApproval.mockReset();
  mockResolveApproval.mockReset();
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("a secret-access approval card", () => {
  it("asks for the name, the duration and the reason, in a neutral card with no action name", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const { container } = mount(preview());

    expect(screen.getByText("GITHUB_TOKEN")).toBeTruthy();
    expect(screen.getByText("15 min")).toBeTruthy();
    expect(screen.getByText("Push the release tag")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow 15 min" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.queryByText("Guardian approval needed")).toBeNull();
    expect(screen.queryByText("vault_apply")).toBeNull();
    expect(container.querySelector("[class*='warning']")).toBeNull();
    await waitFor(() =>
      expect(container.querySelector("[data-chat-pending-card='approval']")).toBeTruthy(),
    );
  });

  it("takes the duration from the request", () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    mount(preview({ ttlMinutes: 180 }));
    expect(screen.getByRole("button", { name: "Allow 180 min" })).toBeTruthy();
  });

  it("asks for a six-digit PIN before Allow, in six slots over one numeric input", () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    const { container } = mount(preview());
    const field = pinField();
    expect(container.querySelectorAll('[data-slot="input-otp-slot"]')).toHaveLength(6);
    expect(field.inputMode).toBe("numeric");
    expect(field.maxLength).toBe(6);
    expect(field.autocomplete).toBe("off");
    expect(allowButton().disabled).toBe(true);
  });

  it("draws a dot for each digit and never the digit", async () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    const { container } = mount(preview());
    await userEvent.type(pinField(), "12");
    const slots = [...container.querySelectorAll('[data-slot="input-otp-slot"]')];
    expect(slots.map((slot) => slot.textContent)).toEqual(["", "", "", "", "", ""]);
    expect(container.querySelectorAll('[data-slot="input-otp-dot"]')).toHaveLength(2);
  });

  it("shows the digits while the eye is pressed, and masks them again", async () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    const { container } = mount(preview());
    await userEvent.type(pinField(), "12");
    const eye = screen.getByRole("button", { name: "Show PIN" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(eye);
    const shown = screen.getByRole("button", { name: "Hide PIN" });
    expect(shown.getAttribute("aria-pressed")).toBe("true");
    const slots = [...container.querySelectorAll('[data-slot="input-otp-slot"]')];
    expect(slots.slice(0, 2).map((slot) => slot.textContent)).toEqual(["1", "2"]);
    await userEvent.click(shown);
    expect(container.querySelectorAll('[data-slot="input-otp-dot"]')).toHaveLength(2);
  });

  it("puts the slots under the reason, and the answers on their own row", () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    const { container } = mount(preview());
    const column = screen.getByText("Push the release tag").parentElement;
    expect(column?.contains(container.querySelector('[data-slot="input-otp"]'))).toBe(true);
    const answers = allowButton().parentElement;
    expect(answers?.contains(screen.getByRole("button", { name: "Reject" }))).toBe(true);
    expect(answers?.classList).toContain("justify-end");
    expect(answers?.contains(container.querySelector('[data-slot="input-otp"]'))).toBe(false);
    expect(column?.contains(allowButton())).toBe(false);
  });

  it("keeps digits only and enables Allow at six", async () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    mount(preview());
    await userEvent.type(pinField(), "12ab345");
    expect(pinField().value).toBe("12345");
    expect(allowButton().disabled).toBe(true);
    await userEvent.type(pinField(), "6");
    expect(allowButton().disabled).toBe(false);
  });

  it("allows with the PIN through the vault and folds, not through the generic approve", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const grant = mockGrant(200, { ok: true });
    mount(preview());
    await userEvent.type(pinField(), "123456");
    await userEvent.click(allowButton());
    await screen.findByRole("button", { name: "Allowed GITHUB_TOKEN · 15 min" });
    expect(grant).toHaveBeenCalledTimes(1);
    const [url, init] = grant.mock.calls[0];
    expect(url).toBe("/api/vault/grants");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      approvalId: "appr-1",
      names: ["GITHUB_TOKEN"],
      ttlMinutes: 15,
      pin: "123456",
    });
    expect(mockResolveApproval).not.toHaveBeenCalled();
  });

  it("submits on Enter, and not before six digits", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const grant = mockGrant(200, { ok: true });
    mount(preview());
    await userEvent.type(pinField(), "123{enter}");
    expect(grant).not.toHaveBeenCalled();
    await userEvent.type(pinField(), "456{enter}");
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
  });

  it("clears the PIN after a submit, so a wrong one is retyped", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mockGrant(403, { error: "wrong_pin", attemptsLeft: 2 });
    mount(preview());
    await userEvent.type(pinField(), "000000");
    await userEvent.click(allowButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong PIN. 2 tries left.");
    expect(pinField().value).toBe("");
    expect(allowButton().disabled).toBe(true);
  });

  it("marks the slots invalid with the error, and plays one shake for each new error", async () => {
    const animate = rs.fn();
    Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true });
    try {
      mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
      mockGrant(403, { error: "wrong_pin", attemptsLeft: 2 });
      const { container } = mount(preview());
      const slots = () => [...container.querySelectorAll('[data-slot="input-otp-slot"]')];
      expect(slots().some((slot) => slot.hasAttribute("aria-invalid"))).toBe(false);

      await userEvent.type(pinField(), "000000");
      await userEvent.click(allowButton());
      await screen.findByRole("alert");
      expect(slots().every((slot) => slot.getAttribute("aria-invalid") === "true")).toBe(true);
      expect(animate).toHaveBeenCalledTimes(1);

      // The same message again is a new error and plays again.
      await userEvent.type(pinField(), "000000");
      await userEvent.click(allowButton());
      await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
    } finally {
      Reflect.deleteProperty(Element.prototype, "animate");
    }
  });

  it("does not shake for a guardian who prefers reduced motion", async () => {
    const animate = rs.fn();
    Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true });
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true }),
      configurable: true,
    });
    try {
      mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
      mockGrant(403, { error: "wrong_pin", attemptsLeft: 2 });
      mount(preview());
      await userEvent.type(pinField(), "000000");
      await userEvent.click(allowButton());
      await screen.findByRole("alert");
      expect(animate).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Element.prototype, "animate");
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it.each([
    [403, { error: "wrong_pin", attemptsLeft: 1 }, "Wrong PIN. 1 try left."],
    [
      423,
      { error: "locked", lockedUntil: "2026-11-16T10:15:00.000Z" },
      /^Locked\. Try again at \S+/,
    ],
    [409, { error: "pin_not_set" }, "Set a PIN in Settings first."],
    [
      503,
      {
        error: "The signer is too old for the vault. Upgrade the instance.",
        code: "signer_outdated",
      },
      "The signer is too old for the vault. Upgrade the instance.",
    ],
    [
      409,
      { error: "This request changed or was already answered.", code: "stale_request" },
      "This request changed or was already answered.",
    ],
  ])("shows a %i answer on the error line and keeps the card open", async (status, body, line) => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mockGrant(status, body);
    mount(preview());
    await userEvent.type(pinField(), "000000");
    await userEvent.click(allowButton());
    const alert = await screen.findByRole("alert");
    if (typeof line === "string") expect(alert.textContent).toBe(line);
    else expect(alert.textContent).toMatch(line);
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("rejects through the generic route, with no PIN", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mockResolveApproval.mockResolvedValue({ ok: true });
    const grant = mockGrant(200, { ok: true });
    mount(preview());
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(mockResolveApproval).toHaveBeenCalledWith("appr-1", "reject"));
    expect(grant).not.toHaveBeenCalled();
  });

  it("folds an allowed request to one line, without the reason", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount(preview());
    const fold = await screen.findByRole("button", { name: "Allowed GITHUB_TOKEN · 15 min" });
    expect(fold.textContent).toBe("Allowed GITHUB_TOKEN · 15 min");
    expect(screen.queryByText("Push the release tag")).toBeNull();
    // Opened, it shows the request again, now with no answers to give.
    fold.click();
    expect(await screen.findByText("Push the release tag")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("folds a rejected request to one line", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
    mount(preview());
    const fold = await screen.findByRole("button", { name: "Rejected GITHUB_TOKEN" });
    expect(fold.textContent).toBe("Rejected GITHUB_TOKEN");
    expect(screen.queryByText("Push the release tag")).toBeNull();
  });

  it("reads a request Rome turned down as any approval does", async () => {
    mockFetchApproval.mockResolvedValue(
      record({ status: "rejected", resolvedBy: "rome:task-ended" }),
    );
    mount(preview());
    expect(await screen.findByText(/^Turned down/)).toBeTruthy();
  });

  describe("a request for several secrets", () => {
    const several = () =>
      preview({
        name: "GITHUB_TOKEN",
        names: ["GITHUB_TOKEN", "STRIPE_KEY"],
        title: "Use GITHUB_TOKEN, STRIPE_KEY for 15 min",
      });

    it("lists the names in one card, with one duration, one PIN and one pair of answers", async () => {
      mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
      mount(several());
      expect(screen.getByText("GITHUB_TOKEN, STRIPE_KEY").className).toContain("font-mono");
      expect(screen.getAllByText("15 min")).toHaveLength(1);
      expect(screen.getAllByLabelText("PIN")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Allow 15 min" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    });

    it("allows all of them with one PIN", async () => {
      mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
      const grant = mockGrant(200, { ok: true });
      mount(several());
      await userEvent.type(pinField(), "123456");
      await userEvent.click(allowButton());
      await screen.findByRole("button", { name: "Allowed GITHUB_TOKEN, STRIPE_KEY · 15 min" });
      expect(grant).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(grant.mock.calls[0][1]?.body))).toEqual({
        approvalId: "appr-1",
        names: ["GITHUB_TOKEN", "STRIPE_KEY"],
        ttlMinutes: 15,
        pin: "123456",
      });
    });

    it("folds a rejected request to one line with every name", async () => {
      mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
      mount(several());
      expect(
        await screen.findByRole("button", { name: "Rejected GITHUB_TOKEN, STRIPE_KEY" }),
      ).toBeTruthy();
    });

    it("joins the names the way Chinese does", async () => {
      await i18n.changeLanguage("zh-CN");
      try {
        mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
        mount(several());
        const allowed = "已允许 GITHUB_TOKEN、STRIPE_KEY · 15 分钟";
        expect(await screen.findByText(allowed)).toBeTruthy();
        cleanup();
        mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
        mount(several());
        expect(await screen.findByText("已拒绝 GITHUB_TOKEN、STRIPE_KEY")).toBeTruthy();
      } finally {
        await i18n.changeLanguage("en");
      }
    });

    it("reads an older request that carries one name alone", async () => {
      mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
      mount(preview());
      expect(await screen.findByText("Allowed GITHUB_TOKEN · 15 min")).toBeTruthy();
    });
  });

  it("wraps a long name anywhere, on the card and folded", async () => {
    const name = "PRODUCTION_DATABASE_READONLY_REPLICA_PASSWORD_2026";
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const pending = mount(preview({ name }));
    expect(screen.getByText(name).className).toContain("wrap-anywhere");
    pending.unmount();

    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount(preview({ name }));
    const line = await screen.findByText(`Allowed ${name} · 15 min`);
    expect(line.className).toContain("wrap-anywhere");
  });

  it("speaks Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
      mount(preview());
      expect(screen.getByText("15 分钟")).toBeTruthy();
      expect(screen.getByRole("button", { name: "允许 15 分钟" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
      mockGrant(403, { error: "wrong_pin", attemptsLeft: 2 });
      await userEvent.type(screen.getByLabelText("PIN"), "000000");
      await userEvent.click(screen.getByRole("button", { name: "允许 15 分钟" }));
      expect((await screen.findByRole("alert")).textContent).toBe("PIN 不对，还剩 2 次");
      cleanup();

      mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
      mount(preview());
      expect(await screen.findByText("已允许 GITHUB_TOKEN · 15 分钟")).toBeTruthy();
      cleanup();

      mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
      mount(preview());
      expect(await screen.findByText("已拒绝 GITHUB_TOKEN")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("a secret-access preview from another action", () => {
  it("draws the generic card, with its action name", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mount(preview(), "full", "other:use_secret");
    expect(screen.getByText("Guardian approval needed")).toBeTruthy();
    expect(screen.getByText("use_secret")).toBeTruthy();
    expect(screen.getByText("Use GITHUB_TOKEN for 15 min")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow 15 min" })).toBeNull();
  });

  it("folds to its title and the generic outcome", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount(preview(), "fold", "other:use_secret");
    const fold = await screen.findByRole("button", { name: /Use GITHUB_TOKEN for 15 min/ });
    expect(fold.textContent).toBe("Use GITHUB_TOKEN for 15 minApproved");
  });
});

describe("the generic approval card", () => {
  it("keeps its warning frame, action name and title", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mount({ kind: "generic", title: "Send email", summary: "To the team" }, "full", "send_email");
    expect(screen.getByText("Guardian approval needed")).toBeTruthy();
    expect(screen.getByText("send_email")).toBeTruthy();
    expect(screen.getByText("Send email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("still folds to its title and outcome", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount({ kind: "generic", title: "Send email", summary: "To the team" });
    const fold = await screen.findByRole("button", { name: /Send email/ });
    expect(fold.textContent).toBe("Send emailApproved");
  });
});
