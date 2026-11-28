// @rstest-environment jsdom
import type {
  AppConnectionAccessAuditEntryDto,
  AppConnectionAccessPolicyDto,
  AppConnectionScopeCheck,
  ConnectionAppAccessDto,
  PutAppConnectionAccessPolicy,
} from "@rome/api-types/app-connection-access";
import { feishuOperationScopes } from "@rome/api-types/app-connection-access";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { ConnectionAppAccess } from "./ConnectionAppAccess";

rs.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    disabled,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const endpoint = "/api/app-connection-access/connections/bot-a";
const read = "feishu.document.read";
const write = "feishu.document.update";
const spaces = "feishu.wiki.spaces";
const checkedAt = "2026-11-26T00:00:00Z";
const detail: ConnectionAppAccessDto = {
  connection: { connectionId: "bot-a", connectionKind: "feishu", label: "Bot A" },
  identities: [
    {
      identity: "app",
      actState: "available",
      providerGuidance: {
        consoleUrl: "https://open.feishu.cn/app/cli_test",
        scopeCheckOperation: "feishu.scopes.list",
      },
      operations: [
        {
          name: read,
          sideEffect: "read-only",
          requiredScopes: ["docx:read", "docx:metadata"],
        },
        { name: write, sideEffect: "write" },
        {
          name: spaces,
          sideEffect: "read-only",
          ...feishuOperationScopes("wiki.spaces"),
        },
      ],
    },
    {
      identity: "assistant",
      actState: "available",
      operations: [{ name: "wiki.read", sideEffect: "read-only" }],
    },
  ],
  policies: [],
};
const installedApps = [
  { id: "@a/app-a", displayName: "App A", isEnabled: true },
  { id: "app-b", displayName: "App B", isEnabled: true },
];

function currentPolicy(
  operation: string,
  constraints: AppConnectionAccessPolicyDto["constraints"] = [],
  appId = "@a/app-a",
): AppConnectionAccessPolicyDto {
  return {
    appId,
    connectionId: "bot-a",
    identity: "app",
    operation,
    constraints,
    sideEffect: "read-only",
    approvalMode: "not_required",
    grantStatus: "current",
    revision: 1,
    expiresAt: null,
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
}

function setup({
  data = detail,
  detailResponses = [],
  apps = installedApps,
  scopes = [],
  audit = [],
}: {
  data?: ConnectionAppAccessDto;
  detailResponses?: Response[];
  apps?: typeof installedApps;
  scopes?: AppConnectionScopeCheck[];
  audit?: AppConnectionAccessAuditEntryDto[];
} = {}) {
  let policies = [...data.policies];
  let revision = policies.length;
  const puts: PutAppConnectionAccessPolicy[] = [];
  const deletes: string[] = [];
  const requests: string[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const url = String(input);
    requests.push(url);
    if (url === endpoint) return detailResponses.shift() ?? Response.json({ ...data, policies });
    if (url === "/api/apps") return Response.json({ apps });
    if (url === `${endpoint}/audit`) return Response.json({ entries: audit, nextBeforeSeq: null });
    if (url === `${endpoint}/scopes/check` && options?.method === "POST") {
      const result = scopes.shift();
      return result ? Response.json(result) : Response.json({ error: "Offline" }, { status: 502 });
    }
    if (url === `${endpoint}/policies` && options?.method === "PUT") {
      const body = JSON.parse(String(options.body)) as PutAppConnectionAccessPolicy;
      puts.push(body);
      const existing = policies.find(
        (item) =>
          item.appId === body.appId &&
          item.identity === body.identity &&
          item.operation === body.operation,
      );
      const policy: AppConnectionAccessPolicyDto = {
        ...body,
        connectionId: "bot-a",
        sideEffect: body.operation === write ? "write" : "read-only",
        approvalMode: body.approvalMode ?? "not_required",
        constraints: existing?.constraints ?? [],
        expiresAt: null,
        grantStatus: "current",
        revision: ++revision,
        createdAt: checkedAt,
        updatedAt: checkedAt,
      };
      policies = [
        ...policies.filter(
          (item) =>
            item.appId !== body.appId ||
            item.identity !== body.identity ||
            item.operation !== body.operation,
        ),
        policy,
      ];
      return Response.json({ policy });
    }
    if (url.startsWith(`${endpoint}/policies/`) && options?.method === "DELETE") {
      deletes.push(url);
      const [appId, identity, operation] = url
        .slice(`${endpoint}/policies/`.length)
        .split("/")
        .map(decodeURIComponent);
      policies = policies.filter(
        (item) =>
          item.appId !== appId || item.identity !== identity || item.operation !== operation,
      );
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "Unexpected request" }, { status: 404 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConnectionAppAccess connectionId="bot-a" />
    </QueryClientProvider>,
  );
  return { puts, deletes, requests, client };
}

function opRow(operation: string) {
  const el = document.querySelector<HTMLLIElement>(`li[data-operation="${operation}"]`);
  if (!el) throw new Error(`Operation row not found: ${operation}`);
  return within(el);
}

function opModeSelect(operation: string) {
  return opRow(operation).getAllByRole<HTMLSelectElement>("combobox")[0];
}

async function openManualApp(appId: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Authorize an app" }));
  const dialog = await screen.findByRole("dialog", { name: "Authorize an app" });
  fireEvent.change(within(dialog).getAllByRole("combobox")[0], { target: { value: appId } });
  await userEvent.click(within(dialog).getByRole("button", { name: "Customize permissions" }));
}

async function openAuthorizedApp(name: string) {
  const btn = await screen.findByRole("button", { name: new RegExp(name) });
  await userEvent.click(btn);
}

describe("ConnectionAppAccess", () => {
  it("shows authorized-apps-first overview, defers audit until opened, and refreshes cleanly", async () => {
    const { requests } = setup({
      data: { ...detail, policies: [currentPolicy(read)] },
    });
    expect(await screen.findByText("App A")).toBeTruthy();
    expect(screen.queryByText("App B")).toBeNull();
    expect(requests).toEqual([endpoint, "/api/apps"]);

    await userEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await waitFor(() => expect(requests.filter((url) => url === "/api/apps")).toHaveLength(2));
    expect(requests.filter((url) => url === endpoint)).toHaveLength(2);
    expect(requests).toHaveLength(4);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides unsupported connections without loading apps and handles an empty catalog", async () => {
    const { requests } = setup({ data: { ...detail, identities: [] } });
    await waitFor(() => expect(requests).toEqual([endpoint]));
    expect(screen.queryByText("App Access")).toBeNull();
    cleanup();
    setup({ apps: [] });
    expect(await screen.findByText("No apps are installed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Authorize an app" })).toBeNull();
  });

  it("shows a localized load error and retries the connection before loading apps", async () => {
    const { requests } = setup({ detailResponses: [new Response(null, { status: 503 })] });
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load app access.");
    expect(requests).toEqual([endpoint]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No authorized apps yet");
    expect(requests).toEqual([endpoint, endpoint, "/api/apps"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides missing connections without offering a retry", async () => {
    const { client, requests } = setup({ detailResponses: [new Response(null, { status: 404 })] });
    await waitFor(() => expect(client.getQueryState([endpoint])?.status).toBe("error"));
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(requests).toEqual([endpoint]);
  });

  it("supports quick manual preset authorization in a modal dialog with Customize permissions between Cancel and Grant access", async () => {
    const { puts } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Authorize an app" }));
    const dialog = await screen.findByRole("dialog", { name: "Authorize an app" });

    // Footer buttons appear in order: Cancel → Customize permissions → Grant access
    const footerButtons = within(dialog)
      .getAllByRole("button")
      .map((btn) => btn.textContent?.trim())
      .filter(Boolean);
    expect(footerButtons).toEqual(["Cancel", "Customize permissions", "Grant access"]);

    // Cancel closes the modal cleanly
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Reopen and grant preset
    await userEvent.click(screen.getByRole("button", { name: "Authorize an app" }));
    const reopened = await screen.findByRole("dialog", { name: "Authorize an app" });
    fireEvent.change(within(reopened).getAllByRole("combobox")[0], { target: { value: "app-b" } });
    await userEvent.click(within(reopened).getByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(puts.map((p) => p.operation)).toEqual([read, spaces]));
    expect(puts.every((p) => p.appId === "app-b")).toBe(true);
    // Opens the newly authorized app in a modal dialog
    const appDialog = await screen.findByRole("dialog", { name: "App B" });
    await userEvent.click(within(appDialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("button", { name: /App B/ })).toBeTruthy();
  });

  it("opens app editing in a modal with gray permission IDs and Feishu/Lark developer doc links", async () => {
    const larkDetail: ConnectionAppAccessDto = {
      ...detail,
      identities: [
        {
          ...detail.identities[0],
          providerGuidance: {
            consoleUrl: "https://open.larksuite.com/app/cli_lark",
            scopesUrl: "https://open.larksuite.com/app/cli_lark/auth",
            scopeCheckOperation: "feishu.scopes.list",
          },
        },
      ],
      policies: [currentPolicy(read)],
    };
    setup({ data: larkDetail });
    await openAuthorizedApp("App A");

    const dialog = await screen.findByRole("dialog", { name: "App A" });
    const readRow = within(dialog.querySelector<HTMLLIElement>(`li[data-operation="${read}"]`)!);
    expect(readRow.getByText("docx:read")).toBeTruthy();
    expect(readRow.getByText("docx:metadata")).toBeTruthy();
    expect(
      readRow
        .getByRole("link", { name: "Open developer documentation for Read documents" })
        .getAttribute("href"),
    ).toBe(
      "https://open.larksuite.com/document/server-docs/docs/docs/docx-v1/document/raw_content",
    );

    const spacesRow = within(
      dialog.querySelector<HTMLLIElement>(`li[data-operation="${spaces}"]`)!,
    );
    expect(spacesRow.getByText("wiki:space:retrieve")).toBeTruthy();
    expect(
      spacesRow
        .getByRole("link", { name: "Open developer documentation for List Wiki spaces" })
        .getAttribute("href"),
    ).toBe("https://open.larksuite.com/document/server-docs/docs/wiki-v2/space/list");

    // Operations without declared scopes still show their operation ID
    const writeRow = within(dialog.querySelector<HTMLLIElement>(`li[data-operation="${write}"]`)!);
    expect(writeRow.getByText(write)).toBeTruthy();
    expect(
      writeRow
        .getByRole("link", { name: "Open developer documentation for Update documents" })
        .getAttribute("href"),
    ).toBe(
      "https://open.larksuite.com/document/server-docs/docs/docs/docx-v1/document-block/create",
    );

    // ProviderScopes summary card is hidden inside AppDetailDialog
    expect(within(dialog).queryByText("Provider permissions")).toBeNull();

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows +N badge for extra equivalent scopes and does not render fine-grained document config trays", async () => {
    const { puts, deletes } = setup();
    await openManualApp("app-b");

    // No per-operation fine-grained configure button is rendered for any operation
    expect(opRow(read).queryByRole("button", { name: /Configure/ })).toBeNull();
    expect(opRow(write).queryByRole("button", { name: /Configure/ })).toBeNull();
    expect(opRow(spaces).queryByRole("button", { name: /Configure/ })).toBeNull();

    // Extra equivalent scopes render as a compact +N badge on the title line with full scope list accessible
    const extraBadge = opRow(spaces).getByText("+2");
    expect(extraBadge.getAttribute("aria-label")).toContain("wiki:wiki:readonly");
    expect(extraBadge.getAttribute("aria-label")).toContain("wiki:wiki");
    expect(extraBadge.className).toContain("text-badge");
    expect(extraBadge.className).toContain("h-5");

    // Granting and revoking via the dropdown works cleanly
    fireEvent.change(opModeSelect(read), { target: { value: "allow" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      appId: "app-b",
      expectedRevision: 0,
      identity: "app",
      operation: read,
      approvalMode: "not_required",
    });

    await waitFor(() => expect(opModeSelect(read).value).toBe("allow"));
    fireEvent.change(opModeSelect(read), { target: { value: "disabled" } });
    await waitFor(() => expect(deletes).toEqual([`${endpoint}/policies/app-b/app/${read}`]));
  });

  it("changes per-operation access via dropdown, applies config templates, and revokes all grants across identities", async () => {
    const { puts, deletes } = setup();
    await openManualApp("@a/app-a");
    // No redundant "Requires approval" badge on write operations
    expect(opRow(write).queryByText("Requires approval")).toBeNull();

    // Dropdown exposes the 3 modes for both read-only and write operations
    const expectedModes = [
      { value: "disabled", label: "Disabled", disabled: false },
      { value: "allow", label: "Allow", disabled: false },
      { value: "ask", label: "Ask every time", disabled: false },
    ];
    for (const op of [read, write]) {
      const options = Array.from(opModeSelect(op).options).map((opt) => ({
        value: opt.value,
        label: opt.textContent,
        disabled: opt.disabled,
      }));
      expect(options).toEqual(expectedModes);
    }

    fireEvent.change(opModeSelect(read), { target: { value: "ask" } });
    await waitFor(() =>
      expect(puts[0]).toMatchObject({ operation: read, approvalMode: "required" }),
    );
    await waitFor(() => expect(opModeSelect(read).value).toBe("ask"));

    fireEvent.change(opModeSelect(write), { target: { value: "allow" } });
    await waitFor(() =>
      expect(puts[1]).toMatchObject({ operation: write, approvalMode: "not_required" }),
    );
    await waitFor(() => expect(opModeSelect(write).value).toBe("allow"));
    fireEvent.change(opModeSelect(write), { target: { value: "ask" } });
    await waitFor(() =>
      expect(puts[2]).toMatchObject({ operation: write, approvalMode: "required" }),
    );

    // Template menu only offers the 3 templates
    const templateTrigger = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Use template",
    });
    await waitFor(() => expect(templateTrigger.disabled).toBe(false));
    await userEvent.click(templateTrigger);
    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((el) => el.textContent)).toEqual([
      expect.stringContaining("All read-only"),
      expect.stringContaining("Read & write (ask on write)"),
      expect.stringContaining("Docs & Wiki read-only"),
    ]);
    await userEvent.click(menuItems[1]);
    await waitFor(() =>
      expect(puts.slice(3).map((item) => item.operation)).toEqual([read, spaces]),
    );
    await waitFor(() => expect(opModeSelect(read).value).toBe("allow"));

    // Switch identity and apply "All read-only" template
    await waitFor(() =>
      expect(screen.getAllByRole<HTMLSelectElement>("combobox")[0].disabled).toBe(false),
    );
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "assistant" } });
    await userEvent.click(await screen.findByRole("button", { name: "Use template" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /All read-only/ }));
    await waitFor(() =>
      expect(puts[5]).toMatchObject({ operation: "wiki.read", identity: "assistant" }),
    );

    const revokeAll = screen.getByRole<HTMLButtonElement>("button", { name: "Revoke all" });
    await waitFor(() => expect(revokeAll.disabled).toBe(false));
    fireEvent.click(revokeAll);
    await waitFor(() =>
      expect(deletes).toEqual([
        `${endpoint}/policies/%40a%2Fapp-a/app/${write}`,
        `${endpoint}/policies/%40a%2Fapp-a/app/${read}`,
        `${endpoint}/policies/%40a%2Fapp-a/app/${spaces}`,
        `${endpoint}/policies/%40a%2Fapp-a/assistant/wiki.read`,
      ]),
    );
  });

  it("renews replaced policies when reapplying an access template after reconnect", async () => {
    const replacedRead: AppConnectionAccessPolicyDto = {
      ...currentPolicy(read),
      grantStatus: "replaced",
    };
    const replacedWrite: AppConnectionAccessPolicyDto = {
      ...currentPolicy(write),
      sideEffect: "write",
      approvalMode: "required",
      grantStatus: "replaced",
    };
    const { puts } = setup({
      data: { ...detail, policies: [replacedRead, replacedWrite] },
    });
    await openAuthorizedApp("App A");

    const templateTrigger = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Use template",
    });
    await waitFor(() => expect(templateTrigger.disabled).toBe(false));
    await userEvent.click(templateTrigger);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Read & write \(ask on write\)/ }),
    );

    await waitFor(() => expect(puts).toHaveLength(3));
    expect(puts).toEqual([
      {
        appId: "@a/app-a",
        identity: "app",
        operation: read,
        expectedRevision: 1,
        approvalMode: "not_required",
      },
      {
        appId: "@a/app-a",
        identity: "app",
        operation: write,
        expectedRevision: 1,
        approvalMode: "required",
      },
      {
        appId: "@a/app-a",
        identity: "app",
        operation: spaces,
        expectedRevision: 0,
        approvalMode: "not_required",
      },
    ]);
  });

  it("renews individual replaced permissions directly after reconnect", async () => {
    const replacedRead: AppConnectionAccessPolicyDto = {
      ...currentPolicy(read),
      grantStatus: "replaced",
    };
    const replacedWrite: AppConnectionAccessPolicyDto = {
      ...currentPolicy(write),
      sideEffect: "write",
      approvalMode: "required",
      grantStatus: "replaced",
    };
    const { puts } = setup({
      data: { ...detail, policies: [replacedRead, replacedWrite] },
    });
    await openAuthorizedApp("App A");

    const renewRead = opRow(read).getByRole("button", { name: "Renew" });
    await userEvent.click(renewRead);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      appId: "@a/app-a",
      identity: "app",
      operation: read,
      expectedRevision: 1,
      approvalMode: "not_required",
    });
    await waitFor(() => expect(opRow(read).queryByRole("button", { name: "Renew" })).toBeNull());

    const renewWrite = opRow(write).getByRole("button", { name: "Renew" });
    await userEvent.click(renewWrite);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({
      appId: "@a/app-a",
      identity: "app",
      operation: write,
      expectedRevision: 1,
      approvalMode: "required",
    });
    await waitFor(() => expect(opRow(write).queryByRole("button", { name: "Renew" })).toBeNull());
  });

  it("omits constraints when changing access mode so the server preserves stored constraints", async () => {
    const extra = { inputPointer: "/workspace", allowedValues: [4, true] };
    const constraints = [{ inputPointer: "/documentId", allowedValues: ["A", "B"] }, extra];
    const { puts } = setup({ data: { ...detail, policies: [currentPolicy(read, constraints)] } });
    await openAuthorizedApp("App A");

    fireEvent.change(opModeSelect(read), { target: { value: "ask" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      appId: "@a/app-a",
      identity: "app",
      operation: read,
      expectedRevision: 1,
      approvalMode: "required",
    });
    await waitFor(() => expect(opModeSelect(read).value).toBe("ask"));
  });

  it("refreshes and explains a revision conflict after a stale access mode edit", async () => {
    const previous = currentPolicy(read);
    const current = {
      ...currentPolicy(read),
      revision: 2,
    };
    const { requests } = setup({
      detailResponses: [Response.json({ ...detail, policies: [previous] })],
      data: { ...detail, policies: [current] },
    });
    await openAuthorizedApp("App A");

    const fetch = rs.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      Response.json({ error: "policy_conflict", message: "Revision mismatch" }, { status: 409 }),
    );
    fireEvent.change(opModeSelect(read), { target: { value: "ask" } });
    const feedback = await screen.findByRole("alert");
    expect(feedback.textContent).toBe(
      "This access policy changed elsewhere. Review the refreshed policy before saving again.",
    );
    const put = fetch.mock.calls.find(
      ([url, options]) => url === endpoint + "/policies" && options?.method === "PUT",
    );
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      appId: "@a/app-a",
      identity: "app",
      operation: read,
      expectedRevision: 1,
      approvalMode: "required",
    });
    expect(requests.filter((url) => url === endpoint)).toHaveLength(2);
  });

  it("keeps standalone scopes alongside granted alternatives", async () => {
    const operation = {
      name: "feishu.calendar.events.list",
      sideEffect: "read-only" as const,
      requiredScopes: ["tenant.read", "calendar:calendar.event:read"],
      requiredScopeGroups: [["calendar:calendar.event:read", "calendar:calendar:readonly"]],
    };
    setup({
      data: {
        ...detail,
        identities: [{ ...detail.identities[0], operations: [operation] }],
        policies: [currentPolicy(operation.name)],
      },
      scopes: [
        {
          status: "checked",
          checkedAt,
          scopes: [{ scopeName: "calendar:calendar:readonly", grantStatus: 1 }],
        },
      ],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Check scopes" }));
    const status = within(await screen.findByRole("status"));
    expect(
      within(status.getByText("tenant.read").closest("li")!).getByText("Missing"),
    ).toBeTruthy();
    expect(
      within(status.getByText("calendar:calendar.event:read").closest("li")!).getByText("Granted"),
    ).toBeTruthy();
  });

  it("checks each scope group against bot grants and ignores user-only grants", async () => {
    setup({
      data: { ...detail, policies: [currentPolicy(read), currentPolicy(spaces)] },
      scopes: [
        {
          status: "checked",
          checkedAt,
          scopes: [
            { scopeName: "docx:read", grantStatus: 1, scopeType: "user" },
            { scopeName: "docx:metadata", grantStatus: 1 },
            { scopeName: "wiki:wiki:readonly", grantStatus: 1, scopeType: "tenant" },
          ],
        },
      ],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Check scopes" }));
    const dialog = await screen.findByRole("dialog", { name: "Provider permissions" });
    await within(dialog).findByText("Provider scopes checked.");
    const status = within(within(dialog).getByRole("status"));
    expect(status.getByText("Documents")).toBeTruthy();
    expect(status.getByText("Wiki")).toBeTruthy();
    expect(within(status.getByText("docx:read").closest("li")!).getByText("Missing")).toBeTruthy();
    expect(
      within(status.getByText("docx:metadata").closest("li")!).getByText("Granted"),
    ).toBeTruthy();
    const wikiItem = within(status.getByText("wiki:space:retrieve").closest("li")!);
    expect(wikiItem.getByText("Granted")).toBeTruthy();
    expect(
      wikiItem
        .getByRole("link", { name: "Open developer documentation for List Wiki spaces" })
        .getAttribute("href"),
    ).toBe("https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/list");
    expect(status.getAllByText("Missing")).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(await screen.findByRole("dialog", { name: "Provider permissions" })).toBeTruthy();
  });

  it("checks base message history scopes and accepts only supported drive metadata scopes", async () => {
    const operations = (["im.messages.list", "drive.inspect"] as const).map((name) => ({
      name: "feishu." + name,
      sideEffect: "read-only" as const,
      ...feishuOperationScopes(name),
    }));
    const cases = [
      {
        granted: ["im:message.group_msg", "drive:drive:readonly"],
        expected: ["Missing", "Missing"],
      },
      {
        granted: ["im:message:readonly", "drive:drive.metadata:readonly"],
        expected: ["Granted", "Granted"],
      },
      {
        granted: ["im:message.history:readonly", "drive:drive"],
        expected: ["Granted", "Granted"],
      },
      { granted: ["im:message"], expected: ["Granted", "Missing"] },
    ];
    setup({
      data: {
        ...detail,
        identities: [{ ...detail.identities[0], operations }],
        policies: operations.map(({ name }) => currentPolicy(name)),
      },
      scopes: cases.map(({ granted }) => ({
        status: "checked",
        checkedAt,
        scopes: granted.map((scopeName) => ({ scopeName, grantStatus: 1 })),
      })),
    });
    await screen.findByText("App A");
    for (const { expected } of cases) {
      await userEvent.click(screen.getByRole("button", { name: "Check scopes" }));
      await waitFor(() => {
        const status = within(screen.getByRole("status"));
        for (const [index, scopeText] of [
          "im:message:readonly",
          "drive:drive.metadata:readonly",
        ].entries()) {
          expect(
            within(status.getByText(scopeText).closest("li")!).getByText(expected[index]),
          ).toBeTruthy();
        }
      });
    }
  });

  it("warns against retrying writes with an unknown outcome in the activity log", async () => {
    setup({
      audit: [
        {
          seq: 1,
          appId: "app-b",
          connectionId: "bot-a",
          identity: "app",
          operation: write,
          accessRevision: 1,
          approval: "approved",
          executionId: "run",
          requestIdHash: null,
          status: "outcome_unknown",
          createdAt: checkedAt,
        },
      ],
    });
    await userEvent.click(await screen.findByRole("radio", { name: "Activity" }));
    const badge = await screen.findByText("Outcome unknown — do not retry");
    expect(badge.className).toContain("bg-warning-bg");
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("compares current grant scopes only when the provider check succeeds", async () => {
    setup({
      scopes: [
        {
          status: "checked",
          checkedAt,
          scopes: [
            { scopeName: "docx:read", grantStatus: 1 },
            { scopeName: "docx:metadata", grantStatus: 2 },
          ],
        },
        { status: "unavailable", checkedAt, errorCode: "authorization_required" },
        { status: "error", checkedAt, errorCode: "provider_unavailable" },
        { status: "unsupported", checkedAt },
      ],
    });
    const user = userEvent.setup();
    expect(
      (await screen.findByRole("link", { name: "Developer console" })).getAttribute("href"),
    ).toBe("https://open.feishu.cn/app/cli_test");

    await openManualApp("@a/app-a");
    fireEvent.change(opModeSelect(read), { target: { value: "allow" } });
    await waitFor(() => expect(opModeSelect(read).value).toBe("allow"));
    await user.click(screen.getByRole("button", { name: "Done" }));

    const check = () => user.click(screen.getByRole("button", { name: "Check scopes" }));
    await check();
    await screen.findByText("Provider scopes checked.");
    expect(within(screen.getByRole("status")).getByText("Granted")).toBeTruthy();
    expect(within(screen.getByRole("status")).getByText("Missing")).toBeTruthy();
    expect(within(screen.getByRole("status")).getByText(/Checked at/)).toBeTruthy();
    for (const state of [
      "The connection is unavailable for a scope check.",
      "Could not check provider scopes.",
      "This provider does not support scope checks.",
      "Could not check provider scopes.",
    ]) {
      await check();
      await screen.findByText(state);
      expect(screen.queryByText("Missing")).toBeNull();
    }
  });
});
