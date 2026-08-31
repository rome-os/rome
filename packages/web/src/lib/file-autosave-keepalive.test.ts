import { describe, expect, it } from "@rstest/core";
import {
  KEEPALIVE_MAX_BODY_BYTES,
  createFileSaveRequestBody,
  fitsKeepaliveFileSavePayload,
} from "./file-autosave-keepalive";

describe("file autosave keepalive helpers", () => {
  it("measures the serialized save body instead of raw content length", () => {
    const path = "memory/MEMORY.md";
    const content = "\u0000".repeat(22000);
    const body = createFileSaveRequestBody({ commit: false, content, path });

    expect(content.length + path.length).toBeLessThan(KEEPALIVE_MAX_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(KEEPALIVE_MAX_BODY_BYTES);
    expect(fitsKeepaliveFileSavePayload({ commit: false, content, path })).toBe(false);
  });

  it("accepts payloads whose serialized body fits the keepalive limit", () => {
    expect(
      fitsKeepaliveFileSavePayload({
        commit: false,
        content: "draft\n",
        path: "memory/MEMORY.md",
      }),
    ).toBe(true);
  });
});
