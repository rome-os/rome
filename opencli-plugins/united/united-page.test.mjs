import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readUnitedPage } from "./united-page.mjs";

function read({ body = "", dialogs = [], alerts = [] } = {}) {
  const document = {
    body: { innerText: body },
    documentElement: { lang: "en" },
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogs;
      if (selector === '[role="alert"]') return alerts.map((text) => ({ innerText: text }));
      return [];
    },
  };
  return vm.runInNewContext(`(${readUnitedPage.toString()})()`, {
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: { href: "https://www.united.com/en/us/fsr/choose-flights" },
  });
}

test("reader remains serializable without module-scope helpers", () => {
  const data = read();
  assert.equal(data.rows.length, 0);
  assert.equal(data.no_results, false);
  assert.equal(data.price_mode, null);
});

test("reader separates an unloaded page, explicit no flights, and a provider error", () => {
  assert.equal(read({ body: "Loading results..." }).loading, true);
  for (const body of [
    "We couldn't find any flights",
    "We couldn’t find any flights",
    "No flights match",
  ]) {
    assert.equal(read({ body }).no_results, true);
  }
  const failure = read({
    alerts: [
      "We're sorry, but united.com was unable to complete your request. Please try again later.",
    ],
  });
  assert.equal(failure.service_error, true);
  assert.equal(failure.no_results, false);
});

test("reader detects a visible sign-in wall, not an ordinary sign-in link or hidden dialog", () => {
  assert.equal(read({ body: "Sign in" }).login_required, false);
  const dialog = {
    innerText: "Email or MileagePlus number",
    getClientRects: () => [],
    closest: () => null,
  };
  assert.equal(read({ dialogs: [dialog] }).login_required, false);
  dialog.getClientRects = () => [{}];
  assert.equal(read({ dialogs: [dialog] }).login_required, true);
});

test("reader does not return the page body or account text", () => {
  const result = read({ body: "Hi SAMPLE_ACCOUNT, 1234567 miles. Account SAMPLE_ID." });
  assert.doesNotMatch(JSON.stringify(result), /SAMPLE_ACCOUNT|SAMPLE_ID|1234567/);
});
