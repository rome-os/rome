import { describe, expect, it } from "@rstest/core";
import { cn } from "./utils";

describe("cn", () => {
  it.each(["4", "8", "12", "16"])("lets rounded-%s override another radius utility", (radius) => {
    expect(cn("rounded-full", `rounded-${radius}`)).toBe(`rounded-${radius}`);
    expect(cn(`rounded-${radius}`, "rounded-full")).toBe("rounded-full");
  });
});
