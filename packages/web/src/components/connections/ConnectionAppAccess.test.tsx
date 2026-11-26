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
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
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
          resourceConstraintKind: "documentIds",
          requiredScopes: ["docx:read", "docx:metadata"],
        },
        { name: write, sideEffect: "write", approvalRequired: true },
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
      const policy: AppConnectionAccessPolicyDto = {
        ...body,
        connectionId: "bot-a",
        sideEffect: body.operation === write ? "write" : "read-only",
        approvalMode: body.approvalMode ?? "not_required",
        constraints: body.constraints ?? [],
        expiresAt: body.expiresAt ?? null,
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

async function openManualApp(appId: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Authorize an app" }));
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: appId } });
  await userEvent.click(screen.getByRole("button", { name: "Configure individually" }));
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

  it("supports quick manual preset authorization from the overview", async () => {
    const { puts } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Authorize an app" }));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "app-b" } });
    await userEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(puts.map((p) => p.operation)).toEqual([read, spaces]));
    expect(puts.every((p) => p.appId === "app-b")).toBe(true);
    // Drills straight into the newly authorized app
    expect(await screen.findByText("App B")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: /App B/ })).toBeTruthy();
  });

  it("grants, updates, and revokes only the selected app's document access via the inline config tray", async () => {
    const { puts, deletes } = setup();
    await openManualApp("app-b");

    await userEvent.click(opRow(read).getByRole("button", { name: "Configure Read documents" }));
    const input = opRow(read).getByRole("textbox", { name: "Allowed documents" });
    fireEvent.change(input, { target: { value: "https://other.test/docx/DocumentA" } });
    expect(opRow(read).getByRole<HTMLButtonElement>("button", { name: "Grant" }).disabled).toBe(
      true,
    );

    fireEvent.change(input, {
      target: { value: "DocumentA, https://demo.feishu.cn/docx/DocumentB?from=share\nDocumentA" },
    });
    fireEvent.change(opRow(read).getByRole("combobox"), { target: { value: "7d" } });
    fireEvent.click(opRow(read).getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      appId: "app-b",
      expectedRevision: 0,
      identity: "app",
      operation: read,
      constraints: [{ inputPointer: "/documentId", allowedValues: ["DocumentA", "DocumentB"] }],
    });
    expect(Date.parse(puts[0].expiresAt!) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);

    await waitFor(() => expect(opRow(read).getByText("2 docs allowed")).toBeTruthy());
    fireEvent.change(opRow(read).getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(opRow(read).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(puts[1]).toMatchObject({
        expectedRevision: 1,
        constraints: [],
        expiresAt: puts[0].expiresAt,
      }),
    );

    // Toggle switch OFF revokes immediately
    const toggle = opRow(read).getByRole("switch", { name: "Read documents" });
    await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
    await userEvent.click(toggle);
    await waitFor(() => expect(deletes).toEqual([`${endpoint}/policies/app-b/app/${read}`]));
  });

  it("toggles operations with Switch, grants missing reads, and revokes all grants across identities", async () => {
    const { puts, deletes } = setup();
    await openManualApp("@a/app-a");
    expect(opRow(write).getByText("Requires approval")).toBeTruthy();

    await userEvent.click(opRow(write).getByRole("switch", { name: "Update documents" }));
    await waitFor(() =>
      expect(puts[0]).toMatchObject({ operation: write, approvalMode: "required" }),
    );

    const batch = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Grant all reads",
    });
    await waitFor(() => expect(batch.disabled).toBe(false));
    fireEvent.click(batch);
    await waitFor(() =>
      expect(puts.slice(1).map((item) => item.operation)).toEqual([read, spaces]),
    );

    await waitFor(() =>
      expect(screen.getAllByRole<HTMLSelectElement>("combobox")[0].disabled).toBe(false),
    );
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "assistant" } });
    fireEvent.click(await screen.findByRole("button", { name: "Grant all reads" }));
    await waitFor(() =>
      expect(puts[3]).toMatchObject({ operation: "wiki.read", identity: "assistant" }),
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

  it("preserves every constraint verbatim when only expiry changes and edits only document rules", async () => {
    const extra = { inputPointer: "/workspace", allowedValues: [4, true] };
    const constraints = [
      { inputPointer: "/documentId", allowedValues: ["A", "B"] },
      extra,
      { inputPointer: "/documentId", allowedValues: ["A"] },
    ];
    const { puts } = setup({ data: { ...detail, policies: [currentPolicy(read, constraints)] } });
    await openAuthorizedApp("App A");
    await userEvent.click(opRow(read).getByRole("button", { name: "Configure Read documents" }));

    expect(opRow(read).getByRole<HTMLTextAreaElement>("textbox").value).toBe("A");
    fireEvent.change(opRow(read).getByRole("combobox"), { target: { value: "7d" } });
    fireEvent.click(opRow(read).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].constraints).toEqual(constraints);
    expect(Date.parse(puts[0].expiresAt!)).toBeGreaterThan(Date.now());
    await waitFor(() =>
      expect(opRow(read).getByRole<HTMLSelectElement>("combobox").value).toBe("keep"),
    );
    fireEvent.change(opRow(read).getByRole("textbox"), { target: { value: "C" } });
    fireEvent.click(opRow(read).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(puts[1]?.constraints).toEqual([
        extra,
        { inputPointer: "/documentId", allowedValues: ["C"] },
      ]),
    );
  });

  it("keeps a disjoint document policy closed when its empty draft is saved", async () => {
    const rules = ["A", "B"].map((id) => ({ inputPointer: "/documentId", allowedValues: [id] }));
    const { puts } = setup({ data: { ...detail, policies: [currentPolicy(read, rules)] } });
    await openAuthorizedApp("App A");
    await userEvent.click(opRow(read).getByRole("button", { name: "Configure Read documents" }));

    expect(await screen.findByText(/current rules allow no documents/)).toBeTruthy();
    fireEvent.click(opRow(read).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts[0]?.constraints).toEqual(rules));
  });

  it("refreshes the allowlist and explains a revision conflict after a stale expiry edit", async () => {
    const previous = currentPolicy(read, [
      { inputPointer: "/documentId", allowedValues: ["A", "B"] },
    ]);
    const current = {
      ...currentPolicy(read, [{ inputPointer: "/documentId", allowedValues: ["A"] }]),
      revision: 2,
    };
    const { requests } = setup({
      detailResponses: [Response.json({ ...detail, policies: [previous] })],
      data: { ...detail, policies: [current] },
    });
    await openAuthorizedApp("App A");
    await userEvent.click(opRow(read).getByRole("button", { name: "Configure Read documents" }));

    expect(opRow(read).getByRole<HTMLTextAreaElement>("textbox").value).toBe("A\nB");
    const fetch = rs.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      Response.json({ error: "policy_conflict", message: "Revision mismatch" }, { status: 409 }),
    );
    fireEvent.change(opRow(read).getByRole("combobox"), { target: { value: "7d" } });
    fireEvent.click(opRow(read).getByRole("button", { name: "Save changes" }));
    const feedback = await screen.findByRole("alert");
    expect(feedback.textContent).toBe(
      "This access policy changed elsewhere. Review the refreshed policy before saving again.",
    );
    const put = fetch.mock.calls.find(
      ([url, options]) => url === endpoint + "/policies" && options?.method === "PUT",
    );
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      expectedRevision: 1,
      constraints: previous.constraints,
    });
    expect(requests.filter((url) => url === endpoint)).toHaveLength(2);
    expect(opRow(read).getByRole<HTMLTextAreaElement>("textbox").value).toBe("A");
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
    await screen.findByText("Provider scopes checked.");
    const status = within(screen.getByRole("status"));
    expect(within(status.getByText("docx:read").closest("li")!).getByText("Missing")).toBeTruthy();
    expect(
      within(status.getByText("docx:metadata").closest("li")!).getByText("Granted"),
    ).toBeTruthy();
    expect(
      within(status.getByText("wiki:space:retrieve").closest("li")!).getByText("Granted"),
    ).toBeTruthy();
    expect(status.getAllByText("Missing")).toHaveLength(1);
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
    await user.click(opRow(read).getByRole("switch", { name: "Read documents" }));
    await waitFor(() =>
      expect(
        opRow(read).getByRole("switch", { name: "Read documents" }).getAttribute("data-state"),
      ).toBe("checked"),
    );

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
