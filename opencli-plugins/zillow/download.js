import * as fs from "node:fs";
import * as path from "node:path";
import { httpDownload } from "@jackwener/opencli/download";
import { CommandExecutionError, getErrorMessage } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { readZillowListingPhotos } from "./zillow-browser.mjs";
import {
  canonicalZillowListingUrl,
  DEFAULT_ZILLOW_EXAMPLE_URL,
  DEFAULT_ZILLOW_OUTPUT,
  describeZillowListing,
  integerInRange,
  planZillowDownloads,
  summarizeZillowDownload,
  ZILLOW_PHOTO_SIZES,
  zillowListingSlug,
} from "./zillow-helpers.mjs";

cli({
  site: "zillow",
  name: "download",
  access: "read",
  description: "Download every gallery photo of a public Zillow listing",
  example: `opencli zillow download ${DEFAULT_ZILLOW_EXAMPLE_URL} --output ./zillow-downloads`,
  domain: "zillow.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    {
      name: "url",
      type: "string",
      positional: true,
      required: true,
      help: `Zillow listing URL, e.g. ${DEFAULT_ZILLOW_EXAMPLE_URL}`,
    },
    {
      name: "output",
      type: "string",
      default: DEFAULT_ZILLOW_OUTPUT,
      help: "Directory that receives one <address>-<zpid> folder per listing",
    },
    {
      name: "size",
      type: "string",
      default: "full",
      choices: ZILLOW_PHOTO_SIZES,
      help: "Photo variant to download: full (widest original-ratio bucket, up to 1536px), large (1344px), medium (1024px), small (800px), or thumb (384px crop)",
    },
    {
      name: "limit",
      type: "int",
      default: 0,
      help: "Maximum photos to download in gallery order (0 = all)",
    },
  ],
  columns: ["index", "status", "size", "file", "caption", "width", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError("Browser session required for zillow download");
    let url;
    let limit;
    let output;
    try {
      url = canonicalZillowListingUrl(kwargs.url);
      limit = integerInRange(kwargs.limit ?? 0, "limit", 0, 1000);
      output = String(kwargs.output || DEFAULT_ZILLOW_OUTPUT).trim() || DEFAULT_ZILLOW_OUTPUT;
      if (!ZILLOW_PHOTO_SIZES.includes(kwargs.size)) {
        throw new Error(`size must be one of: ${ZILLOW_PHOTO_SIZES.join(", ")}`);
      }
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }

    const { pageData, photos } = await readZillowListingPhotos(page, url);
    const listing = describeZillowListing(pageData, url);
    const plan = planZillowDownloads(photos, { size: kwargs.size, limit });

    const outputDir = path.resolve(output, zillowListingSlug(listing.url || url));
    fs.mkdirSync(outputDir, { recursive: true });

    const rows = [];
    for (const item of plan) {
      if (!item.url) {
        rows.push(
          summarizeZillowDownload(item, { success: false, error: "No photo URL" }, { listing }),
        );
        continue;
      }
      const file = path.join(outputDir, item.file_name);
      let result;
      try {
        result = await httpDownload(item.url, file, {
          headers: { Referer: "https://www.zillow.com/" },
          timeout: 60000,
        });
      } catch (error) {
        result = { success: false, size: 0, error: getErrorMessage(error) };
      }
      rows.push(summarizeZillowDownload(item, result, { listing, file }));
    }
    return rows;
  },
});
