import * as fs from "node:fs";
import * as path from "node:path";
import { httpDownload } from "@jackwener/opencli/download";
import { CommandExecutionError, getErrorMessage } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { readRedfinListingPhotos } from "./redfin-browser.mjs";
import {
  canonicalRedfinListingUrl,
  DEFAULT_REDFIN_EXAMPLE_URL,
  DEFAULT_REDFIN_OUTPUT,
  describeRedfinListing,
  integerInRange,
  planRedfinDownloads,
  REDFIN_PHOTO_SIZES,
  redfinListingSlug,
  summarizeRedfinDownload,
} from "./redfin-helpers.mjs";

cli({
  site: "redfin",
  name: "download",
  access: "read",
  description: "Download every gallery photo of a public Redfin listing",
  example: `opencli redfin download ${DEFAULT_REDFIN_EXAMPLE_URL} --output ./redfin-downloads`,
  domain: "redfin.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    {
      name: "url",
      type: "string",
      positional: true,
      required: true,
      help: `Redfin listing URL, e.g. ${DEFAULT_REDFIN_EXAMPLE_URL}`,
    },
    {
      name: "output",
      type: "string",
      default: DEFAULT_REDFIN_OUTPUT,
      help: "Directory that receives one <address>-<property id> folder per listing",
    },
    {
      name: "size",
      type: "string",
      default: "full",
      choices: REDFIN_PHOTO_SIZES,
      help: "Photo variant to download: full (original frame), large, medium, small, or thumb",
    },
    {
      name: "limit",
      type: "int",
      default: 0,
      help: "Maximum photos to download in gallery order (0 = all)",
    },
  ],
  columns: ["index", "status", "size", "file", "caption", "tags", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError("Browser session required for redfin download");
    let url;
    let limit;
    let output;
    try {
      url = canonicalRedfinListingUrl(kwargs.url);
      limit = integerInRange(kwargs.limit ?? 0, "limit", 0, 1000);
      output = String(kwargs.output || DEFAULT_REDFIN_OUTPUT).trim() || DEFAULT_REDFIN_OUTPUT;
      if (!REDFIN_PHOTO_SIZES.includes(kwargs.size)) {
        throw new Error(`size must be one of: ${REDFIN_PHOTO_SIZES.join(", ")}`);
      }
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }

    const { pageData, photos } = await readRedfinListingPhotos(page, url);
    const listing = describeRedfinListing(pageData, url);
    const plan = planRedfinDownloads(photos, { size: kwargs.size, limit });

    const outputDir = path.resolve(output, redfinListingSlug(url));
    fs.mkdirSync(outputDir, { recursive: true });

    const rows = [];
    for (const item of plan) {
      if (!item.url) {
        rows.push(
          summarizeRedfinDownload(item, { success: false, error: "No photo URL" }, { listing }),
        );
        continue;
      }
      const file = path.join(outputDir, item.file_name);
      let result;
      try {
        result = await httpDownload(item.url, file, {
          headers: { Referer: "https://www.redfin.com/" },
          timeout: 60000,
        });
      } catch (error) {
        result = { success: false, size: 0, error: getErrorMessage(error) };
      }
      rows.push(summarizeRedfinDownload(item, result, { listing, file }));
    }
    return rows;
  },
});
