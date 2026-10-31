import { type Locator, type Page, test as base, expect } from "@playwright/test";

// Every test fails on a page error or a 5xx from Rome, whatever it asserts:
// a migration that breaks a read the page makes in passing should not pass
// because the assertion looked elsewhere. (The Midscene backend suite keeps
// the same record as a report; here it is a failure.)

interface Anomaly {
  kind: "pageerror" | "http";
  detail: string;
}

export const test = base.extend<{ anomalies: Anomaly[] }>({
  anomalies: [
    async ({ page }, use, testInfo) => {
      const anomalies: Anomaly[] = [];
      page.on("pageerror", (error) => anomalies.push({ kind: "pageerror", detail: error.message }));
      page.on("response", (response) => {
        if (response.status() < 500) return;
        const url = new URL(response.url());
        anomalies.push({
          kind: "http",
          detail: `${response.status()} ${response.request().method()} ${url.pathname}`,
        });
      });
      await use(anomalies);
      if (anomalies.length > 0 && testInfo.status === testInfo.expectedStatus) {
        throw new Error(
          `The page hit errors:\n${anomalies.map((a) => `  ${a.kind}: ${a.detail}`).join("\n")}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };

/** The dashboard's chat list row for a chat title. */
export function chatRow(page: Page, title: string): Locator {
  return page.locator("[data-chat-row]").filter({ hasText: title });
}

/** The open chat's message composer. */
function composer(page: Page): Locator {
  return page.getByRole("textbox").last();
}

/** Starts a new dashboard chat with `text` and waits for its URL. */
export async function startChat(page: Page, text: string): Promise<string> {
  await page.goto("/chat");
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

/** Sends `text` into the open chat. */
export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** Opens the actions menu of a chat list row. */
export async function openChatActions(page: Page, title: string): Promise<void> {
  const row = chatRow(page, title);
  await row.hover();
  await row.getByRole("button", { name: "Chat actions" }).click();
}
