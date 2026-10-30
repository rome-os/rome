import { describe, expect, it, rs } from "@rstest/core";
import { createInstance } from "i18next";
import { createBundleBackend, createBundleLoader } from "./bundle-loader";
import { NAMESPACES, type LocaleBundle } from "./namespaces";

function bundleOf(greeting: string): LocaleBundle {
  return Object.fromEntries(
    NAMESPACES.map((ns) => [ns, { greeting: `${greeting} (${ns})` }]),
  ) as LocaleBundle;
}

function setup(preloaded: string[] = []) {
  const importers = {
    en: rs.fn(async () => ({ default: bundleOf("Hello") })),
    "zh-CN": rs.fn(async () => ({ default: bundleOf("你好") })),
  };
  const loader = createBundleLoader(importers);
  for (const language of preloaded) {
    loader.register(language, bundleOf(language === "en" ? "Hello" : "你好"));
  }
  const create = (lng: string) => {
    const i18n = createInstance();
    const ready = i18n.use(createBundleBackend(loader)).init({
      lng,
      fallbackLng: "en",
      supportedLngs: ["en", "zh-CN"],
      defaultNS: "common",
      ns: [...NAMESPACES],
      initAsync: false,
    });
    return { i18n, ready };
  };
  return { importers, loader, create };
}

describe("lazy locale loading", () => {
  it("downloads only the active language for an English visitor", async () => {
    const { importers, create } = setup();
    const { i18n, ready } = create("en");
    await ready;
    expect(importers.en).toHaveBeenCalledTimes(1);
    expect(importers["zh-CN"]).not.toHaveBeenCalled();
    expect(i18n.t("greeting")).toBe("Hello (common)");
  });

  it("downloads the visitor's language plus the English fallback for a Chinese visitor", async () => {
    const { importers, create } = setup();
    const { i18n, ready } = create("zh-CN");
    await ready;
    expect(importers["zh-CN"]).toHaveBeenCalledTimes(1);
    expect(importers.en).toHaveBeenCalledTimes(1);
    expect(i18n.t("greeting")).toBe("你好 (common)");
    // The fallback is in the store, so a key a translation lacks still resolves.
    expect(i18n.getResource("en", "chat", "greeting")).toBe("Hello (chat)");
  });

  it("fetches each language once however many namespaces ask for it", async () => {
    const { importers, create } = setup();
    await create("en").ready;
    expect(importers.en).toHaveBeenCalledTimes(1);
  });

  it("is not ready, and has no text, until the language arrives", async () => {
    let release: (bundle: { default: LocaleBundle }) => void = () => {};
    const loader = createBundleLoader({
      en: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const i18n = createInstance();
    const ready = i18n.use(createBundleBackend(loader)).init({
      lng: "en",
      fallbackLng: "en",
      ns: [...NAMESPACES],
      defaultNS: "common",
      initAsync: false,
    });
    expect(i18n.isInitialized).toBeFalsy();
    expect(i18n.t("greeting")).toBe("greeting");
    release({ default: bundleOf("Hello") });
    await ready;
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("greeting")).toBe("Hello (common)");
  });

  it("loads the other language on demand when the visitor switches", async () => {
    const { importers, create } = setup();
    const { i18n, ready } = create("en");
    await ready;
    expect(importers["zh-CN"]).not.toHaveBeenCalled();
    await i18n.changeLanguage("zh-CN");
    expect(importers["zh-CN"]).toHaveBeenCalledTimes(1);
    expect(i18n.t("greeting")).toBe("你好 (common)");
  });

  it("completes in the same tick when the languages were registered up front", () => {
    const { importers, create } = setup(["en", "zh-CN"]);
    const { i18n } = create("zh-CN");
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("greeting")).toBe("你好 (common)");
    expect(importers.en).not.toHaveBeenCalled();
    expect(importers["zh-CN"]).not.toHaveBeenCalled();
  });

  it("retries a language whose download failed", async () => {
    let attempts = 0;
    const loader = createBundleLoader({
      en: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Loading chunk locale-en failed.");
        return { default: bundleOf("Hello") };
      },
    });
    await expect(loader.load("en")).rejects.toThrow("Loading chunk");
    await expect(loader.load("en")).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("rejects a language it has no bundle for", async () => {
    const loader = createBundleLoader({});
    await expect(loader.load("fr")).rejects.toThrow('No locale bundle for "fr"');
  });
});
