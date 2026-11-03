import { afterEach, describe, expect, it, rs } from "@rstest/core";

// The module remembers that it reported, so every test gets a fresh instance.
async function loadReporter() {
  rs.resetModules();
  return (await import("./guardian-timezone")).reportDetectedTimezoneOnce;
}

afterEach(() => {
  rs.restoreAllMocks();
});

describe("reportDetectedTimezoneOnce", () => {
  it("posts the browser zone once per page load", async () => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    const reportDetectedTimezoneOnce = await loadReporter();

    await reportDetectedTimezoneOnce();
    await reportDetectedTimezoneOnce();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/guardian-timezone/detected");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("swallows a failed post", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("offline");
    });
    const reportDetectedTimezoneOnce = await loadReporter();

    await expect(reportDetectedTimezoneOnce()).resolves.toBeUndefined();
  });
});
