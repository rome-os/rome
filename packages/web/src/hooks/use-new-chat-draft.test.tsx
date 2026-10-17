// @rstest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { AUTH_QUERY_KEY } from "@/lib/auth-state";
import { DASHBOARD_IDENTITY_QUERY_KEY } from "./use-dashboard-identity";
import { useNewChatDraft, type NewChatSeed } from "./use-new-chat-draft";
import { useNewChatDraftCleanup } from "./use-new-chat-draft-cleanup";
import {
  activateDraftOwner,
  clearNewChatDrafts,
  emptyNewChatDraft,
  readNewChatDraft,
  writeNewChatDraft,
} from "@/lib/new-chat-draft-storage";
const A = "guardian:A";
const raw = "  中文🙂\nraw whitespace\n  ";
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  sessionStorage.clear();
});
function fixture(identity: string | null = "A") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(AUTH_QUERY_KEY, {
    ready: true,
    backendReachable: true,
    bootstrap: { phase: "ready" },
  });
  if (identity)
    client.setQueryData(DASHBOARD_IDENTITY_QUERY_KEY, { kind: "guardian", userId: identity });
  rs.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise(() => {}));
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </StrictMode>
    );
  }
  const identityAs = async (userId: string) => {
    act(() => {
      client.setQueryData(DASHBOARD_IDENTITY_QUERY_KEY, { kind: "guardian", userId });
    });
    await waitFor(() =>
      expect(client.getQueryData(DASHBOARD_IDENTITY_QUERY_KEY)).toEqual({
        kind: "guardian",
        userId,
      }),
    );
  };
  return { client, wrapper, identityAs };
}
describe("local new-chat draft", () => {
  it("hydrates before saving, then restores exact fields on remount/reload equivalent", () => {
    activateDraftOwner(A);
    const saved = {
      ...emptyNewChatDraft(),
      text: raw,
      projectPath: "/synthetic",
      skill: { name: "skill" },
      personaId: "p",
    };
    writeNewChatDraft(A, saved);
    const f = fixture();
    const first = renderHook(() => useNewChatDraft(true), f);
    expect(first.result.current.value).toEqual(saved);
    first.unmount();
    const second = renderHook(() => useNewChatDraft(true), f);
    expect(second.result.current.value).toEqual(saved);
    expect(readNewChatDraft(A)?.value).toEqual(saved);
  });
  it("does not write anonymous/empty data while identity is loading; late hydration respects typing", async () => {
    const f = fixture(null);
    const hook = renderHook(() => useNewChatDraft(true), f);
    act(() => hook.result.current.change("text", raw));
    expect(sessionStorage.length).toBe(0);
    await f.identityAs("A");
    await waitFor(() => expect(readNewChatDraft(A)?.value.text).toBe(raw));
    expect(hook.result.current.value.text).toBe(raw);
  });
  it("a disabled/session composer neither reads nor writes the new-chat record", () => {
    activateDraftOwner(A);
    writeNewChatDraft(A, { ...emptyNewChatDraft(), text: raw });
    const hook = renderHook(() => useNewChatDraft(false), fixture());
    expect(hook.result.current.value.text).toBe("");
    act(() => hook.result.current.change("text", "session follow-up"));
    expect(readNewChatDraft(A)?.value.text).toBe(raw);
  });
  it.each([
    true,
    false,
  ])("clears storage at send start, retains upload UI if needed; acceptance stays cleared (optimistic %s)", (optimistic) => {
    const hook = renderHook(() => useNewChatDraft(true), fixture());
    act(() => {
      hook.result.current.change("text", raw);
      hook.result.current.change("skill", { name: "skill" });
    });
    let send!: ReturnType<typeof hook.result.current.beginSend>;
    act(() => {
      send = hook.result.current.beginSend(optimistic);
    });
    expect(readNewChatDraft(A)?.value.text).toBe("");
    expect(hook.result.current.value.text).toBe(optimistic ? "" : raw);
    act(() => send.accept());
    expect(hook.result.current.value.text).toBe("");
    expect(readNewChatDraft(A)?.value.skill).toBeNull();
  });
  it.each([
    true,
    false,
  ])("restores raw text/context on failed/canceled send without newer edits (optimistic %s)", (optimistic) => {
    const hook = renderHook(() => useNewChatDraft(true), fixture());
    act(() => {
      hook.result.current.change("text", raw);
      hook.result.current.change("personaId", "p");
    });
    let send!: ReturnType<typeof hook.result.current.beginSend>;
    act(() => {
      send = hook.result.current.beginSend(optimistic);
      send.fail();
    });
    expect(hook.result.current.value.text).toBe(raw);
    expect(readNewChatDraft(A)?.value.personaId).toBe("p");
  });
  it.each([
    "success",
    "failure",
  ])("B typed then deleted is a newer revision, never replaced by A %s", (outcome) => {
    const hook = renderHook(() => useNewChatDraft(true), fixture());
    act(() => hook.result.current.change("text", "A"));
    let send!: ReturnType<typeof hook.result.current.beginSend>;
    act(() => {
      send = hook.result.current.beginSend(true);
      hook.result.current.change("text", "B");
      hook.result.current.change("text", "");
    });
    act(() => (outcome === "success" ? send.accept() : send.fail()));
    expect(hook.result.current.value.text).toBe("");
    expect(readNewChatDraft(A)?.value.text).toBe("");
  });
  it("edits after early session adoption also prevent old input restoring to New chat", () => {
    const f = fixture();
    const hook = renderHook(({ enabled }) => useNewChatDraft(enabled), {
      ...f,
      initialProps: { enabled: true },
    });
    act(() => hook.result.current.change("text", "A"));
    let send!: ReturnType<typeof hook.result.current.beginSend>;
    act(() => {
      send = hook.result.current.beginSend(true);
    });
    hook.rerender({ enabled: false });
    act(() => {
      hook.result.current.change("text", "B");
      hook.result.current.change("text", "");
      send.fail();
    });
    expect(hook.result.current.value.text).toBe("");
    expect(readNewChatDraft(A)?.value.text).toBe("");
  });
  it("failure after unmount notifies a newly mounted unedited composer in the same window", () => {
    const f = fixture();
    const old = renderHook(() => useNewChatDraft(true), f);
    act(() => old.result.current.change("text", raw));
    let send!: ReturnType<typeof old.result.current.beginSend>;
    act(() => {
      send = old.result.current.beginSend(true);
    });
    old.unmount();
    const fresh = renderHook(() => useNewChatDraft(true), f);
    expect(fresh.result.current.value.text).toBe("");
    act(() => send.fail());
    expect(fresh.result.current.value.text).toBe(raw);
  });
  it("a remounted edit then deletion wins over an older unmounted failure", () => {
    const f = fixture();
    const old = renderHook(() => useNewChatDraft(true), f);
    act(() => old.result.current.change("text", raw));
    let send!: ReturnType<typeof old.result.current.beginSend>;
    act(() => {
      send = old.result.current.beginSend(true);
    });
    old.unmount();
    const fresh = renderHook(() => useNewChatDraft(true), f);
    act(() => {
      fresh.result.current.change("text", "B");
      fresh.result.current.change("text", "");
      send.fail();
    });
    expect(fresh.result.current.value.text).toBe("");
  });
  it("seed receipts survive deletion/remount, conflicting text is consumed, and new seeds work", () => {
    const f = fixture();
    const old = renderHook(({ seed }: { seed: NewChatSeed }) => useNewChatDraft(true, seed), {
      ...f,
      initialProps: { seed: { intent: "route-A", text: raw } },
    });
    expect(old.result.current.value.text).toBe(raw);
    act(() => old.result.current.change("text", "edited"));
    old.rerender({ seed: { intent: "conflict", text: "do not replace" } });
    expect(old.result.current.value.text).toBe("edited");
    act(() => old.result.current.change("text", ""));
    old.unmount();
    const fresh = renderHook(({ seed }: { seed: NewChatSeed }) => useNewChatDraft(true, seed), {
      ...f,
      initialProps: { seed: { intent: "route-A", text: raw } },
    });
    expect(fresh.result.current.value.text).toBe("");
    fresh.rerender({ seed: { intent: "route-new", text: "new seed" } });
    expect(fresh.result.current.value.text).toBe("new seed");
  });
  it("metadata-only successive seeds work; explicit field choices win", () => {
    const f = fixture();
    const hook = renderHook(({ seed }: { seed: NewChatSeed }) => useNewChatDraft(true, seed), {
      ...f,
      initialProps: { seed: { intent: "p1", projectPath: "project-1", skill: { name: "s1" } } },
    });
    hook.rerender({ seed: { intent: "p2", projectPath: "project-2", skill: { name: "s2" } } });
    expect(hook.result.current.value.projectPath).toBe("project-2");
    expect(hook.result.current.value.skill?.name).toBe("s2");
    act(() => hook.result.current.change("projectPath", "manual"));
    hook.rerender({ seed: { intent: "p3", projectPath: "ignored", skill: { name: "s3" } } });
    expect(hook.result.current.value.projectPath).toBe("manual");
    expect(hook.result.current.value.skill?.name).toBe("s3");
  });
  it("A->B->A clears old data and old route seed; a new navigation intent still works", async () => {
    const f = fixture();
    const root = renderHook(() => useNewChatDraftCleanup(), f);
    const hook = renderHook(({ seed }: { seed: NewChatSeed }) => useNewChatDraft(true, seed), {
      ...f,
      initialProps: { seed: { intent: "identity-old-route", text: raw, skill: { name: "s" } } },
    });
    await f.identityAs("B");
    await waitFor(() => expect(hook.result.current.value.text).toBe(""));
    await f.identityAs("A");
    await waitFor(() => expect(hook.result.current.value.skill).toBeNull());
    hook.rerender({ seed: { intent: "identity-new-route", text: "new A" } });
    expect(hook.result.current.value.text).toBe("new A");
    root.unmount();
  });
  it("logout cleanup outside chat invalidates late failure; other storage namespaces survive", async () => {
    const f = fixture();
    const root = renderHook(() => useNewChatDraftCleanup(), f);
    const chat = renderHook(() => useNewChatDraft(true), f);
    act(() => chat.result.current.change("text", raw));
    let send!: ReturnType<typeof chat.result.current.beginSend>;
    act(() => {
      send = chat.result.current.beginSend(true);
    });
    chat.unmount();
    sessionStorage.setItem("rome:pending-app-remix", "keep");
    act(() =>
      f.client.setQueryData(AUTH_QUERY_KEY, {
        ready: true,
        backendReachable: true,
        bootstrap: { phase: "needs-login" },
      }),
    );
    await waitFor(() => expect(readNewChatDraft(A)).toBeNull());
    act(() => send.fail());
    expect(readNewChatDraft(A)).toBeNull();
    expect(sessionStorage.getItem("rome:pending-app-remix")).toBe("keep");
    root.unmount();
  });
  it("storage denial preserves mounted local editing and raw failure recovery", () => {
    rs.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const hook = renderHook(() => useNewChatDraft(true), fixture());
    let send!: ReturnType<typeof hook.result.current.beginSend>;
    act(() => {
      hook.result.current.change("text", raw);
      send = hook.result.current.beginSend(true);
      send.fail();
    });
    expect(hook.result.current.value.text).toBe(raw);
    act(() => clearNewChatDrafts());
    expect(hook.result.current.value.text).toBe("");
  });
});
