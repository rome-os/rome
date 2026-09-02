import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { readRedfinListingPhotos } from "./redfin-browser.mjs";
import {
  canonicalRedfinListingUrl,
  DEFAULT_REDFIN_EXAMPLE_URL,
  describeRedfinListing,
  integerInRange,
  normalizePhotoRow,
  REDFIN_PHOTO_SIZES,
} from "./redfin-helpers.mjs";

cli({
  site: "redfin",
  name: "photos",
  access: "read",
  description: "List every gallery photo of a public Redfin listing with captions and CDN URLs",
  example: `opencli redfin photos ${DEFAULT_REDFIN_EXAMPLE_URL} -f json`,
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
      name: "size",
      type: "string",
      default: "full",
      choices: REDFIN_PHOTO_SIZES,
      help: "Photo variant reported in the url column: full (original frame), large, medium, small, or thumb",
    },
    {
      name: "limit",
      type: "int",
      default: 0,
      help: "Maximum photos to return in gallery order (0 = all)",
    },
  ],
  columns: ["index", "photo_id", "caption", "tags", "source_width", "source_height", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError("Browser session required for redfin photos");
    let url;
    let limit;
    try {
      url = canonicalRedfinListingUrl(kwargs.url);
      limit = integerInRange(kwargs.limit ?? 0, "limit", 0, 1000);
      if (!REDFIN_PHOTO_SIZES.includes(kwargs.size)) {
        throw new Error(`size must be one of: ${REDFIN_PHOTO_SIZES.join(", ")}`);
      }
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }

    const { pageData, photos } = await readRedfinListingPhotos(page, url);
    const listing = describeRedfinListing(pageData, url);
    const selected = limit > 0 ? photos.slice(0, limit) : photos;
    return selected.map((photo) => normalizePhotoRow(photo, listing, kwargs.size));
  },
});
