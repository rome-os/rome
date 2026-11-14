// @rstest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { AppDocumentAccess } from "./app-document-access";
rs.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
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
describe("Core app document authorization", () => {
  it("refreshes only the app list before selection and refreshes scoped queries after selection", async () => {
    const paths: string[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path === "/api/apps")
        return Response.json({ apps: [{ id: "app-a", displayName: "App A", isEnabled: true }] });
      if (path === "/api/app-connection-access/app-a/documents?cursor=0&limit=50")
        return Response.json({ connections: [] });
      if (path === "/api/app-connection-access/app-a") return Response.json({ policies: [] });
      return Response.json({ error: "Unexpected unscoped request" }, { status: 404 });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AppDocumentAccess />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "App document access" }));
    await screen.findByText("App A · app-a");
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await waitFor(() => expect(paths.filter((path) => path === "/api/apps")).toHaveLength(2));
    expect(paths).toEqual(["/api/apps", "/api/apps"]);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "app-a" } });
    await waitFor(() => expect(paths).toHaveLength(4));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await waitFor(() => expect(paths).toHaveLength(7));
    expect(paths.filter((path) => path === "/api/app-connection-access/app-a")).toHaveLength(2);
    expect(
      paths.filter(
        (path) => path === "/api/app-connection-access/app-a/documents?cursor=0&limit=50",
      ),
    ).toHaveLength(2);
  });
  it("does not load provider or app data until opened; submits only the chosen app, bot and document", async () => {
    const writes: Array<{ url: string; method: string; body: unknown }> = [];
    let allowed = false;
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const path = String(url);
      if (options?.method) {
        writes.push({
          url: path,
          method: options.method,
          body: options.body ? JSON.parse(String(options.body)) : null,
        });
        allowed = options.method === "PUT";
        return new Response(options.method === "DELETE" ? null : JSON.stringify({ policy: {} }), {
          status: options.method === "DELETE" ? 204 : 200,
        });
      }
      if (path === "/api/apps")
        return Response.json({
          apps: [
            { id: "app-a", displayName: "App A", isEnabled: true },
            { id: "app-b", displayName: "App B", isEnabled: true },
          ],
        });
      if (path.includes("/documents?"))
        return Response.json({
          connections: [
            {
              connectionId: "bot-a",
              label: "Bot A",
              identity: "app",
              operation: "feishu.document.read",
              supported: true,
              authorized: true,
              scope: "docx:document:readonly",
              scopeStatus: "not_checked",
              consoles: [{ brand: "feishu", url: "https://open.feishu.cn/app/cli_fixture/auth" }],
            },
          ],
        });
      return Response.json({
        policies: allowed
          ? [
              {
                appId: "app-a",
                connectionId: "bot-a",
                identity: "app",
                operation: "feishu.document.read",
                constraints: [{ inputPointer: "/documentId", allowedValues: ["DocumentA"] }],
                grantStatus: "current",
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
              },
            ]
          : [],
      });
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppDocumentAccess />
      </QueryClientProvider>,
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "App document access" }));
    await waitFor(() => expect(screen.getByText("App A · app-a")).toBeTruthy());
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "app-a" } });
    await waitFor(() => expect(screen.getByText(/Bot A/)).toBeTruthy());
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "bot-a" } });
    expect(screen.getByText(/Required bot permission \(not checked\)/)).toBeTruthy();
    expect(
      screen.getByText(/This screen does not request or change provider permissions/),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Document ID (not a URL)" }), {
      target: { value: "DocumentA" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Allow the selected app to read this document" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      url: "/api/app-connection-access/app-a/bot-a/app/feishu.document.read",
      method: "PUT",
      body: {
        approval: "not_required",
        constraints: [{ inputPointer: "/documentId", allowedValues: ["DocumentA"] }],
      },
    });
    expect(
      Date.parse((writes[0].body as { expiresAt: string }).expiresAt) - Date.now(),
    ).toBeGreaterThan(86300000);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoke this app’s access" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke this app’s access" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].method).toBe("DELETE");
    expect(writes.every((item) => item.url.includes("/app-a/"))).toBe(true);
  });
});
