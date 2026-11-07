// Loads an npm package when code first needs it instead of at startup.
import { createRequire } from "node:module";

const requireAtRuntime = createRequire(import.meta.url);

/**
 * Returns a getter that requires `specifier` on its first call and returns the
 * same module on every later call. Use it for a package most processes never
 * touch, such as a chat channel's SDK.
 *
 * A static or dynamic `import` would not defer the load in the Docker image:
 * its bundler hoists every external package import to the top of the bundle.
 * It leaves this runtime require alone.
 */
export function requireOnFirstUse<T>(specifier: string): () => T {
  let loaded: T | undefined;
  return () => {
    loaded ??= requireAtRuntime(specifier) as T;
    return loaded;
  };
}
