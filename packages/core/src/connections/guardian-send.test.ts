import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationId } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import { sendToTarget } from "../people/send.js";
import { asGuardian, isGuardianSend } from "./guardian-send.js";

describe("guardian-send scope", () => {
  it("is closed outside asGuardian", () => {
    expect(isGuardianSend()).toBe(false);
  });

  it("is open for the whole call, across awaits", async () => {
    const seen = await asGuardian(async () => {
      const before = isGuardianSend();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [before, isGuardianSend()];
    });
    expect(seen).toEqual([true, true]);
    expect(isGuardianSend()).toBe(false);
  });

  it("closes for work that outlives the call", async () => {
    let later: Promise<boolean> | undefined;
    await asGuardian(async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(isGuardianSend()), 20));
    });
    expect(await later).toBe(false);
  });

  it("closes when the call throws", async () => {
    let inside: Promise<boolean> | undefined;
    await expect(
      asGuardian(async () => {
        inside = new Promise((resolve) => setTimeout(() => resolve(isGuardianSend()), 20));
        throw new Error("talker refused");
      }),
    ).rejects.toThrow("talker refused");
    expect(await inside).toBe(false);
  });

  it("is open inside the talker only when People sends", async () => {
    const chat = "wxid_a" as ConversationId;
    const seen: boolean[] = [];
    const talkRouter = {
      list: async () => [],
      feature: () => undefined,
      send: async () => {
        seen.push(isGuardianSend());
        return { messageId: "m1" };
      },
    } as unknown as Parameters<typeof sendToTarget>[0]["talkRouter"];

    const receipt = await sendToTarget(
      { talkRouter },
      { connectionId: "c1", conversationId: chat },
      "hi",
    );
    await talkRouter.send("c1", chat, { text: "an agent's send" });

    expect(receipt).toEqual({ messageId: "m1" });
    expect(seen).toEqual([true, false]);
  });

  it("is opened only by people/send.ts", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const openers: string[] = [];
    for (const file of await sourceFiles(src)) {
      if (/\.test\.ts$/.test(file) || file.endsWith("guardian-send.ts")) continue;
      if ((await readFile(file, "utf8")).includes("asGuardian")) openers.push(relative(src, file));
    }
    expect(openers).toEqual(["people/send.ts"]);
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}
