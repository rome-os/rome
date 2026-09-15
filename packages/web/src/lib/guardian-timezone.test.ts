import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { reportDetectedTimezoneOnce, resetDetectedTimezoneReport } from "./guardian-timezone";

describe("reportDetectedTimezoneOnce", () => {
  beforeEach(() => {
    resetDetectedTimezoneReport();
  });

  it("posts the browser zone once per page load", async () => {
    const fetcher = rs.fn(async () => new Response("{}", { status: 200 }));

    await reportDetectedTimezoneOnce(fetcher as unknown as typeof fetch);
    await reportDetectedTimezoneOnce(fetcher as unknown as typeof fetch);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/guardian-timezone/detected");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("swallows a failed post", async () => {
    const fetcher = rs.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      reportDetectedTimezoneOnce(fetcher as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
