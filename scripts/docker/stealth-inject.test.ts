import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "@rstest/core";

const payload = readFileSync(
  fileURLToPath(new URL("./stealth-inject.js", import.meta.url)),
  "utf8",
);

function browserContext(webdriver: boolean) {
  const context = createContext({
    __ROME_STEALTH_LANGUAGES__: ["fr-FR"],
    navigator: {
      webdriver,
      languages: ["en-US", "en"],
      plugins: [{}],
      connection: {},
      hardwareConcurrency: 18,
      deviceMemory: 8,
    },
    screen: { width: 1600, height: 900 },
    window: { chrome: { runtime: {} }, innerWidth: 1280, innerHeight: 720, outerHeight: 800 },
  });
  runInContext("globalThis.originalToString = Function.prototype.toString", context);
  return context;
}

describe("stealth browser payload", () => {
  it("leaves a native browser's properties and built-ins intact", () => {
    const context = browserContext(false);

    runInContext(payload, context);

    expect(runInContext("Function.prototype.toString === originalToString", context)).toBe(true);
    expect(runInContext("navigator.webdriver", context)).toBe(false);
    expect(
      runInContext("Object.getOwnPropertyDescriptor(navigator, 'webdriver').get", context),
    ).toBeUndefined();
    expect(runInContext("navigator.hardwareConcurrency", context)).toBe(18);
    expect(runInContext("screen.width", context)).toBe(1600);
    expect(runInContext("window.outerHeight", context)).toBe(800);
    expect(runInContext("navigator.languages[0]", context)).toBe("en-US");
    expect(runInContext("'__ROME_STEALTH_LANGUAGES__' in globalThis", context)).toBe(false);
  });

  it("retains the shims for a browser that reports WebDriver automation", () => {
    const context = browserContext(true);

    runInContext(payload, context);

    expect(runInContext("navigator.webdriver", context)).toBeUndefined();
    expect(runInContext("navigator.hardwareConcurrency", context)).toBe(8);
    expect(runInContext("screen.width", context)).toBe(1280);
    expect(runInContext("navigator.languages[0]", context)).toBe("fr-FR");
    expect(runInContext("'__ROME_STEALTH_LANGUAGES__' in globalThis", context)).toBe(false);
  });
});
