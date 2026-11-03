/**
 * Members that @rome-os/app-runtime 0.7 removed, answered for that release
 * with the change an app built against 0.6 has to make, rather than with a
 * `Cannot read properties of undefined` from deep inside the app. Each is a
 * non-enumerable getter, so copying, listing or serializing the object never
 * trips it. It is still an own property, so `"name" in target` answers true
 * while the getter is here: an app feature-testing with `in` must read the
 * value.
 *
 * TODO(0.8): remove, with every table of removed members.
 */
export function withRemovedMembers<T extends object>(
  target: T,
  removed: Record<string, string>,
): T {
  for (const [name, migration] of Object.entries(removed)) {
    if (name in target) continue;
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      get() {
        throw new Error(migration);
      },
    });
  }
  return target;
}
