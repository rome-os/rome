import { createLogger } from "../../logger.js";

const logger = createLogger("app-keys");

/**
 * Owns the stored-key slice of `process.env`. Two invariants:
 *
 * - The real process environment always wins. A name that already had a value
 *   before injection is never overwritten — operator config (env files, CI,
 *   container env) cannot be shadowed from the dashboard. Such keys are
 *   reported as overridden instead of silently going live.
 * - Only names this injector set are ever deleted or scrubbed. It tracks its
 *   own writes, so removing a stored key can never unset an operator-set var
 *   that happens to share the name.
 */
export class AppKeyInjector {
  private injected = new Set<string>();
  private overridden = new Set<string>();

  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  /** Applies a stored key. Returns true when the value went live, false when a
   * pre-existing environment value kept precedence. */
  apply(name: string, value: string): boolean {
    if (!this.injected.has(name) && this.env[name] !== undefined) {
      this.overridden.add(name);
      logger.warn(
        `App key ${name} is overridden by the process environment; the stored value is not live`,
      );
      return false;
    }
    this.env[name] = value;
    this.injected.add(name);
    return true;
  }

  /** Removes a stored key from the environment, only if this injector set it.
   * Returns true when the environment actually changed. */
  remove(name: string): boolean {
    this.overridden.delete(name);
    if (!this.injected.has(name)) return false;
    delete this.env[name];
    this.injected.delete(name);
    return true;
  }

  isOverridden(name: string): boolean {
    return this.overridden.has(name);
  }
}
