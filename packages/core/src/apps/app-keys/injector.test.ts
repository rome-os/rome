import { describe, expect, it } from "@rstest/core";
import { AppKeyInjector } from "./injector.js";

describe("AppKeyInjector", () => {
  it("injects into an empty slot and reports it live", () => {
    const env: NodeJS.ProcessEnv = {};
    const injector = new AppKeyInjector(env);
    expect(injector.apply("MY_KEY", "secret")).toBe(true);
    expect(env.MY_KEY).toBe("secret");
    expect(injector.isOverridden("MY_KEY")).toBe(false);
  });

  it("never overwrites a pre-existing environment value", () => {
    const env: NodeJS.ProcessEnv = { MY_KEY: "from-operator" };
    const injector = new AppKeyInjector(env);
    expect(injector.apply("MY_KEY", "from-dashboard")).toBe(false);
    expect(env.MY_KEY).toBe("from-operator");
    expect(injector.isOverridden("MY_KEY")).toBe(true);
  });

  it("updates a value it injected itself", () => {
    const env: NodeJS.ProcessEnv = {};
    const injector = new AppKeyInjector(env);
    injector.apply("MY_KEY", "v1");
    expect(injector.apply("MY_KEY", "v2")).toBe(true);
    expect(env.MY_KEY).toBe("v2");
  });

  it("removes only what it injected, and reports whether the env changed", () => {
    const env: NodeJS.ProcessEnv = { OPERATOR_KEY: "keep" };
    const injector = new AppKeyInjector(env);
    injector.apply("MY_KEY", "secret");
    expect(injector.remove("MY_KEY")).toBe(true);
    expect(injector.remove("MY_KEY")).toBe(false);
    expect(injector.remove("OPERATOR_KEY")).toBe(false);
    expect(env.MY_KEY).toBeUndefined();
    expect(env.OPERATOR_KEY).toBe("keep");
  });

  it("clears the overridden flag when the key is removed", () => {
    const env: NodeJS.ProcessEnv = { MY_KEY: "from-operator" };
    const injector = new AppKeyInjector(env);
    injector.apply("MY_KEY", "from-dashboard");
    expect(injector.isOverridden("MY_KEY")).toBe(true);
    injector.remove("MY_KEY");
    expect(injector.isOverridden("MY_KEY")).toBe(false);
    expect(env.MY_KEY).toBe("from-operator");
  });
});
