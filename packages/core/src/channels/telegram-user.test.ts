import { describe, expect, it, rs } from "@rstest/core";
import { openTelegramUserLogin } from "./telegram-user.js";

// The GramJS client is the process edge: its signInWithPassword call shape is
// the outbound contract under test (onError returning false tells GramJS not
// to retry a static password). The interactive login (openTelegramUserLogin)
// holds one throwaway client + session; the test swaps a fake client onto the
// handle so submitPassword runs against it without dialing Telegram. The login
// writes nothing to disk (the connected account is the setup coroutine's
// terminal return, not a persisted row), so a rejected 2FA
// password rejects with the GramJS error and never yields an account.

type PasswordCallbacks = {
  password: () => Promise<string>;
  onError: (err: Error) => Promise<boolean>;
};

describe("TelegramUserLogin.submitPassword", () => {
  it("does not retry a static 2FA password after GramJS rejects it", async () => {
    const passwordError = new Error("PASSWORD_HASH_INVALID");
    let onErrorResult: unknown;
    const client = {
      signInWithPassword: rs
        .fn()
        .mockImplementation(async (_config: unknown, callbacks: PasswordCallbacks) => {
          expect(await callbacks.password()).toBe("bad-password");
          onErrorResult = await callbacks.onError(passwordError);
          throw passwordError;
        }),
    };

    // The handle builds its own client in the constructor; swap in the fake so
    // submitPassword exercises the GramJS call shape without a real connection.
    const login = openTelegramUserLogin(12345, "hash-secret") as unknown as {
      client: unknown;
      submitPassword: (password: string) => Promise<unknown>;
    };
    login.client = client;

    await expect(login.submitPassword("bad-password")).rejects.toMatchObject({
      message: "PASSWORD_HASH_INVALID",
    });

    expect(onErrorResult).toBe(false);
    expect(client.signInWithPassword).toHaveBeenCalledTimes(1);
  });
});
