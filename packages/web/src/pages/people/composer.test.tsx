// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LinkedAccount, PersonResource } from "@rome/api-types/people";
import i18n from "@/i18n";
import { Composer } from "./composer";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const account: LinkedAccount = {
  channel: "linkedin",
  channelUserId: "ACoAAExample",
  displayName: "Ana Example",
  send: "yes",
  latestAt: null,
};

const person: PersonResource = {
  id: "ana-example",
  displayName: "Ana Example",
  bondLevel: "acquaintance",
  accounts: [account],
  messageCount: 0,
  latest: null,
  memoryPath: null,
};

function renderComposer() {
  const onSend = rs.fn();
  render(<Composer person={person} target={account} onChangeTarget={null} onSend={onSend} />);
  return { onSend, box: screen.getByRole("textbox", { name: "Message text" }) };
}

describe("Composer", () => {
  it("sends pasted text with its line breaks", async () => {
    const user = userEvent.setup();
    const { onSend, box } = renderComposer();

    await user.click(box);
    await user.paste("See https://example.com/demo\n\nExample signature");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      account,
      "See https://example.com/demo\n\nExample signature",
    );
  });

  it("starts a new line on Shift+Enter and sends on Enter", async () => {
    const user = userEvent.setup();
    const { onSend, box } = renderComposer();

    await user.click(box);
    await user.keyboard("Thanks{Shift>}{Enter}{/Shift}Ana");
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(account, "Thanks\nAna");
  });
});
