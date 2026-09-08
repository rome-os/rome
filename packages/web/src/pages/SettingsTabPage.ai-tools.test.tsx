// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { AiToolsPanel } from "@/components/ai-tools-panel";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => structuredClone(json) } as Response;
}

describe("AI Tools refresh", () => {
  it("shows pending state and replaces the displayed provider state", async () => {
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: false }, codex: { loggedIn: false } });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({ providers: [], configured: null });
      }
      if (url === "/api/ai-tools/refresh" && init?.method === "POST") {
        return await refreshResponse;
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);
    const user = userEvent.setup();
    const refresh = await screen.findByRole("button", { name: "Refresh" });
    expect(refresh.getAttribute("data-slot")).toBe("button");
    expect(refresh.getAttribute("data-variant")).toBe("outline");
    expect(refresh.getAttribute("data-size")).toBe("sm");
    expect(refresh.classList.contains("rounded-8")).toBe(true);
    expect(refresh.classList.contains("bg-surface-elevated")).toBe(true);
    await user.click(refresh);

    expect(
      ((await screen.findByRole("button", { name: "Refreshing…" })) as HTMLButtonElement).disabled,
    ).toBe(true);

    resolveRefresh(
      ok({
        claude: { loggedIn: false, quotaExhausted: false },
        codex: {
          loggedIn: true,
          quotaExhausted: false,
          solAccess: true,
          lunaAccess: true,
          authMethod: "ChatGPT",
        },
      }),
    );

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("keeps a refresh failure visible", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: false }, codex: { loggedIn: false } });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({ providers: [], configured: null });
      }
      if (url === "/api/ai-tools/refresh" && init?.method === "POST") {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "AI tool refresh failed." }),
        } as Response;
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    expect((await screen.findByRole("alert")).textContent).toBe("AI tool refresh failed.");
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("AI Tools destructive actions", () => {
  it("confirms Claude logout and keeps an endpoint failure visible", async () => {
    let logoutCalls = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: true }, codex: { loggedIn: false } });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({ providers: [], configured: null });
      }
      if (url === "/api/ai-tools/claude/logout" && init?.method === "POST") {
        logoutCalls += 1;
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Claude logout was rejected." }),
        } as Response;
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Log Out" }));

    expect(logoutCalls).toBe(0);
    const dialog = screen.getByRole("dialog", { name: "Log out of Claude?" });
    expect(within(dialog).getByText("Signs out on this server only.")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Log Out" }));

    await waitFor(() => expect(logoutCalls).toBe(1));
    expect(within(dialog).getByText("Claude logout was rejected.")).toBeTruthy();
  });

  it("confirms removing a saved provider key before deleting it", async () => {
    let removed = false;
    let deleteCalls = 0;
    const configured = {
      provider: "minimax",
      providerName: "MiniMax",
      hasApiKey: true,
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({
          claude: removed
            ? { loggedIn: false }
            : { loggedIn: true, authMethod: "stored-compatible", accountType: "MiniMax" },
          codex: { loggedIn: false },
          anthropicCompatible: removed ? null : configured,
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({
          providers: [
            {
              id: "minimax",
              name: "MiniMax",
              kind: "preset",
              baseUrl: "https://api.minimaxi.com/anthropic",
              apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
            },
          ],
          configured,
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-credentials" && init?.method === "DELETE") {
        deleteCalls += 1;
        removed = true;
        return ok({});
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(deleteCalls).toBe(0);
    const dialog = screen.getByRole("dialog", { name: "Remove MiniMax API key?" });
    expect(
      within(dialog).getByText(
        "Claude sessions stop using MiniMax. Restoring it requires a new key.",
      ),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(deleteCalls).toBe(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Remove MiniMax API key?" })).toBeNull(),
    );
  });
});

describe("AI Tools provider presentation", () => {
  it("supports the onboarding visibility and connection-state contract", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: false }, codex: { loggedIn: true } });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({ providers: [], configured: null });
      }
      return ok({});
    }) as typeof fetch);
    const onConnectedChange = rs.fn();

    render(
      <AiToolsPanel
        hiddenProviders={["gemini"]}
        showHeader={false}
        onConnectedChange={onConnectedChange}
      />,
    );

    expect(await screen.findByText("ChatGPT")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.queryByText("Gemini")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    const claudeLogin = screen.getByRole("button", { name: "Log In" });
    const apiKey = screen.getByRole("button", { name: "API Key" });
    const logOut = screen.getByRole("button", { name: "Log Out" });
    for (const button of [claudeLogin, apiKey, logOut]) {
      expect(button.getAttribute("data-slot")).toBe("button");
      expect(button.getAttribute("data-variant")).toBe("outline");
      expect(button.getAttribute("data-size")).toBe("sm");
      expect(button.classList.contains("rounded-8")).toBe(true);
      expect(button.classList.contains("bg-surface-elevated")).toBe(true);
    }
    expect(screen.getByText("ChatGPT").closest(".bg-surface")).toBeTruthy();
    expect(claudeLogin.parentElement).toBe(apiKey.parentElement);
    expect(claudeLogin.parentElement?.getAttribute("role")).toBe("group");
    expect(
      claudeLogin.compareDocumentPosition(apiKey) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitFor(() => expect(onConnectedChange).toHaveBeenLastCalledWith(true));
  });

  it("shows ChatGPT before Claude", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: false }, codex: { loggedIn: false } });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({ providers: [], configured: null });
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);

    const chatgpt = await screen.findByText("ChatGPT");
    const claude = screen.getByText("Claude");
    const browser = screen.getByRole("button", { name: "Browser" });
    const deviceCode = screen.getByRole("button", { name: "Device code" });
    for (const button of [browser, deviceCode]) {
      expect(button.getAttribute("data-slot")).toBe("button");
      expect(button.getAttribute("data-variant")).toBe("outline");
      expect(button.getAttribute("data-size")).toBe("sm");
      expect(button.classList.contains("rounded-8")).toBe(true);
      expect(button.classList.contains("bg-surface-elevated")).toBe(true);
    }
    expect(chatgpt.compareDocumentPosition(claude) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the API provider logo and source instead of Claude login controls", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({
          claude: {
            loggedIn: true,
            authMethod: "stored-compatible",
            accountType: "MiniMax",
          },
          codex: { loggedIn: true, authMethod: "ChatGPT" },
          anthropicCompatible: {
            provider: "minimax",
            providerName: "MiniMax",
            hasApiKey: true,
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({
          providers: [
            {
              id: "minimax",
              name: "MiniMax",
              baseUrl: "https://api.minimaxi.com/anthropic",
              apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
            },
          ],
          configured: {
            provider: "minimax",
            providerName: "MiniMax",
            hasApiKey: true,
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        });
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);

    expect(await screen.findByText("API key active")).toBeTruthy();
    expect(screen.getByText("MiniMax")).toBeTruthy();
    expect(screen.queryByText("Logging in via")).toBeNull();
    expect(document.querySelector('img[src="/provider-logos/minimax.svg"]')).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Log Out" })).toHaveLength(1);
    const changeProvider = screen.getByRole("button", { name: "Change" });
    const removeProvider = screen.getByRole("button", { name: "Remove" });
    expect(
      changeProvider.compareDocumentPosition(removeProvider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Other API providers")).toBeNull();

    const user = userEvent.setup();
    await user.click(changeProvider);
    expect(screen.getByRole("heading", { name: "Other API providers" })).toBeTruthy();

    const providerSelect = screen.getByRole("combobox");
    expect(providerSelect.querySelector('img[src="/provider-logos/minimax.svg"]')).toBeTruthy();

    await user.click(providerSelect);
    expect(
      screen
        .getByRole("option", { name: "MiniMax" })
        .querySelector('img[src="/provider-logos/minimax.svg"]'),
    ).toBeTruthy();
  });

  it("edits one custom environment through JSON and key-value views", async () => {
    let savedBody: Record<string, unknown> | null = null;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: false }, codex: { loggedIn: false } });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({
          providers: [
            {
              id: "minimax",
              name: "MiniMax",
              kind: "preset",
              baseUrl: "https://api.minimaxi.com/anthropic",
              apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
            },
            { id: "custom", name: "Custom", kind: "custom" },
          ],
          configured: null,
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-credentials" && init?.method === "PUT") {
        savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return ok({
          configured: {
            provider: "custom",
            providerName: "Custom",
            hasApiKey: true,
            env: {
              ANTHROPIC_AUTH_TOKEN: "ark-key",
              ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
              ANTHROPIC_MODEL: "ep-model-updated",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "API Key" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Custom" }));

    const json = screen.getByRole("textbox", { name: "Custom environment JSON" });
    fireEvent.change(json, {
      target: {
        value: JSON.stringify(
          {
            env: {
              ANTHROPIC_AUTH_TOKEN: "ark-key",
              ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
              ANTHROPIC_MODEL: "ep-model",
            },
          },
          null,
          2,
        ),
      },
    });

    await user.click(screen.getByRole("radio", { name: "Key / Value" }));
    const modelValue = screen.getByRole("textbox", { name: "Environment variable 3 value" });
    expect((modelValue as HTMLInputElement).value).toBe("ep-model");
    await user.clear(modelValue);
    await user.type(modelValue, "ep-model-updated");

    await user.click(screen.getByRole("radio", { name: "Paste JSON" }));
    expect(
      (screen.getByRole("textbox", { name: "Custom environment JSON" }) as HTMLTextAreaElement)
        .value,
    ).toContain('"ANTHROPIC_MODEL": "ep-model-updated"');

    await user.click(screen.getByRole("button", { name: "Save Configuration" }));
    await waitFor(() => expect(savedBody).not.toBeNull());
    expect(savedBody).toEqual({
      provider: "custom",
      env: {
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
        ANTHROPIC_MODEL: "ep-model-updated",
      },
    });
  });

  it("edits a stored custom API token as a literal value", async () => {
    let savedBody: Record<string, unknown> | null = null;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({
          claude: { loggedIn: true, authMethod: "stored-compatible", accountType: "Custom" },
          codex: { loggedIn: false },
          anthropicCompatible: {
            provider: "custom",
            providerName: "Custom",
            hasApiKey: true,
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({
          providers: [{ id: "custom", name: "Custom", kind: "custom" }],
          configured: {
            provider: "custom",
            providerName: "Custom",
            hasApiKey: true,
            env: {
              ANTHROPIC_AUTH_TOKEN: "ark-key",
              ANTHROPIC_BASE_URL: "https://ark.example.com/api/plan",
              ANTHROPIC_MODEL: "ep-one",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-credentials" && init?.method === "PUT") {
        savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return ok({});
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Change" }));
    const json = screen.getByRole("textbox", { name: "Custom environment JSON" });
    expect((json as HTMLTextAreaElement).value).toContain('"ANTHROPIC_AUTH_TOKEN": "ark-key"');
    fireEvent.change(json, {
      target: { value: (json as HTMLTextAreaElement).value.replace("ep-one", "ep-two") },
    });
    await user.click(screen.getByRole("button", { name: "Save Configuration" }));

    await waitFor(() => expect(savedBody).not.toBeNull());
    expect(savedBody).toEqual({
      provider: "custom",
      env: {
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.example.com/api/plan",
        ANTHROPIC_MODEL: "ep-two",
      },
    });
  });

  it("explains that an environment API key must be removed from runtime configuration", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({
          claude: {
            loggedIn: true,
            authMethod: "environment",
            accountType: "API key",
          },
          codex: { loggedIn: false },
        });
      }
      if (url === "/api/ai-tools/anthropic-compatible-providers") {
        return ok({ providers: [], configured: null });
      }
      return ok({});
    }) as typeof fetch);

    render(<AiToolsPanel showUsage />);

    expect(await screen.findByText("API key active")).toBeTruthy();
    expect(screen.getByText("Environment API key")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log In" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("button", { name: "API Key" })).toBeTruthy();
  });
});
