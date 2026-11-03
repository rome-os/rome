import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import { doneMessage, pressText } from "./send-task-action";

const t = (key: string, options: Record<string, string>) => i18n.t(key, { ns: "chat", ...options });
const row = (id: string, title: string, archivedAt: number | null = null) => ({
  id,
  title,
  archivedAt,
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("pressText", () => {
  const rows = [row("a1b2c3d4", "Fix flaky test"), row("ffeedd00", "Plan next week")];

  it("says the action and the title, as the guardian would type it", () => {
    expect(pressText(t, "stop", rows[0], rows)).toBe('Stop "Fix flaky test"');
    expect(pressText(t, "archive", rows[1], rows)).toBe('Archive "Plan next week"');
  });

  it("adds the row's first 6 id characters when another open row has the same title", () => {
    const twins = [row("a1b2c3d4", "Fix flaky test"), row("998877aa", "Fix flaky test")];
    expect(pressText(t, "stop", twins[0], twins)).toBe('Stop "Fix flaky test" (task a1b2c3)');
    expect(pressText(t, "archive", twins[1], twins)).toBe('Archive "Fix flaky test" (task 998877)');
  });

  it("ignores an archived row with the same title, and a title that only looks alike", () => {
    const rowsWithArchived = [
      row("a1b2c3d4", "Fix flaky test"),
      row("998877aa", "Fix flaky test", 5),
      row("112233bb", "Fix flaky tests"),
    ];
    expect(pressText(t, "stop", rowsWithArchived[0], rowsWithArchived)).toBe(
      'Stop "Fix flaky test"',
    );
  });

  it("speaks the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(pressText(t, "stop", rows[0], rows)).toBe("停止「Fix flaky test」");
    const twins = [row("a1b2c3d4", "整理邮件"), row("998877aa", "整理邮件")];
    expect(pressText(t, "archive", twins[0], twins)).toBe("归档「整理邮件」 （任务 a1b2c3）");
  });

  it("keeps a title with quotes or markup as it is", () => {
    const odd = [row("a1b2c3d4", 'Reply to "Ann" & <Bob>')];
    expect(pressText(t, "stop", odd[0], odd)).toBe('Stop "Reply to "Ann" & <Bob>"');
  });
});

describe("doneMessage", () => {
  const rows = [row("a1b2c3d4", "Pay rent"), row("ffeedd00", "Plan next week")];

  it("replies to the row's message with a short sentence that leaves the title out", () => {
    const task = { id: "a1b2c3d4", title: "Pay rent", sourceMessageId: "m-ask" };
    expect(doneMessage(t, task, rows)).toEqual({
      text: "I've done this",
      replyToMessageId: "m-ask",
    });
  });

  it("falls back to plain text naming the row when it has no message", () => {
    const task = { id: "a1b2c3d4", title: "Pay rent", sourceMessageId: null };
    expect(doneMessage(t, task, rows)).toEqual({ text: 'Done "Pay rent"' });
    const twins = [row("a1b2c3d4", "Pay rent"), row("998877aa", "Pay rent")];
    expect(doneMessage(t, task, twins)).toEqual({ text: 'Done "Pay rent" (task a1b2c3)' });
  });

  it("speaks the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(
      doneMessage(t, { id: "a1b2c3d4", title: "交房租", sourceMessageId: "m-ask" }, rows).text,
    ).toBe("我已经完成了");
    expect(
      doneMessage(t, { id: "a1b2c3d4", title: "交房租", sourceMessageId: null }, rows).text,
    ).toBe("完成了「交房租」");
  });
});
