import type { BackendModule } from "i18next";
import type { LocaleBundle, Namespace } from "./namespaces";

type Importer = () => Promise<{ default: LocaleBundle }>;

export interface BundleLoader {
  /** Hands over a bundle that is already in memory, so reads of it complete synchronously. */
  register(language: string, bundle: LocaleBundle): void;
  /** The bundle if it is in memory, else undefined. Never starts a download. */
  peek(language: string): LocaleBundle | undefined;
  /** Resolves with the language's bundle, downloading its chunk once. A failed download is retried by the next call. */
  load(language: string): Promise<LocaleBundle>;
}

/** Keeps one language's resources in one lazy chunk, so a session pays for the language it uses. */
export function createBundleLoader(importers: Record<string, Importer>): BundleLoader {
  const ready = new Map<string, LocaleBundle>();
  const inFlight = new Map<string, Promise<LocaleBundle>>();
  return {
    register: (language, bundle) => void ready.set(language, bundle),
    peek: (language) => ready.get(language),
    load(language) {
      const cached = ready.get(language);
      if (cached) return Promise.resolve(cached);
      const pending = inFlight.get(language);
      if (pending) return pending;
      const importer = importers[language];
      if (!importer) return Promise.reject(new Error(`No locale bundle for "${language}"`));
      const started = importer()
        .then((module) => {
          ready.set(language, module.default);
          return module.default;
        })
        .finally(() => inFlight.delete(language));
      inFlight.set(language, started);
      return started;
    },
  };
}

/**
 * An i18next backend that reads from a bundle loader. A language already in
 * memory answers synchronously, which lets `init` finish in the same tick for
 * tests and Storybook, which register every language up front.
 */
export function createBundleBackend(loader: BundleLoader): BackendModule {
  return {
    type: "backend",
    init() {},
    read(language, namespace, callback) {
      const ns = namespace as Namespace;
      const ready = loader.peek(language);
      if (ready) {
        callback(null, ready[ns] ?? {});
        return;
      }
      loader.load(language).then(
        (bundle) => callback(null, bundle[ns] ?? {}),
        (error: unknown) =>
          callback(error instanceof Error ? error : new Error(String(error)), null),
      );
    },
  };
}

export const bundleLoader = createBundleLoader({
  en: () => import(/* webpackChunkName: "locale-en" */ "./bundles/en"),
  "zh-CN": () => import(/* webpackChunkName: "locale-zh-CN" */ "./bundles/zh-CN"),
});
