// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { LOGIN_RETURN_STORAGE_KEY, rememberLoginReturn, takeLoginReturn } from "./login-return";

afterEach(() => {
  window.localStorage.clear();
});

describe("login-return", () => {
  it("returns the remembered page once, then home", () => {
    rememberLoginReturn("/full/apps/ttt?x=1");
    expect(takeLoginReturn()).toBe("/full/apps/ttt?x=1");
    expect(takeLoginReturn()).toBe("/");
  });

  it("goes home when nothing was remembered", () => {
    expect(takeLoginReturn()).toBe("/");
  });

  it("clears an earlier page when the visitor next asked for home", () => {
    rememberLoginReturn("/full/apps/ttt");
    rememberLoginReturn("/");
    expect(window.localStorage.getItem(LOGIN_RETURN_STORAGE_KEY)).toBeNull();
    expect(takeLoginReturn()).toBe("/");
  });

  it("never returns to another origin or to the sign-in page", () => {
    for (const path of ["//evil.example/x", "https://evil.example/", "/login", "/login?next=1"]) {
      window.localStorage.setItem(LOGIN_RETURN_STORAGE_KEY, path);
      expect(takeLoginReturn()).toBe("/");
    }
  });
});
