// Loads an npm package when code first needs it instead of at startup.
import { createRequire } from "node:module";

const requireAtRuntime = createRequire(import.meta.url);

/**
 * Returns a getter that requires `specifier` on its first call and returns the
 * same module on every later call. Use it for a package most processes never
 * touch, such as a chat channel's SDK.
 *
 * Synchronous, so callers such as constructors need not become async. The
 * Docker image's bundler leaves this runtime require alone, while it hoists a
 * static import of the package to the top of the bundle.
 */
export function requireOnFirstUse<T>(specifier: string): () => T {
  let loaded: T | undefined;
  return () => {
    loaded ??= requireAtRuntime(specifier) as T;
    return loaded;
  };
}
