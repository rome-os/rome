import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { readZillowListingPhotos } from "./zillow-browser.mjs";
import {
  canonicalZillowListingUrl,
  DEFAULT_ZILLOW_EXAMPLE_URL,
  describeZillowListing,
  integerInRange,
  normalizePhotoRow,
  ZILLOW_PHOTO_SIZES,
} from "./zillow-helpers.mjs";

cli({
  site: "zillow",
  name: "photos",
  access: "read",
  description: "List every gallery photo of a public Zillow listing with captions and CDN URLs",
  example: `opencli zillow photos ${DEFAULT_ZILLOW_EXAMPLE_URL} -f json`,
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
      name: "size",
      type: "string",
      default: "full",
      choices: ZILLOW_PHOTO_SIZES,
      help: "Photo variant reported in the url column: full (widest original-ratio bucket, up to 1536px), large (1344px), medium (1024px), small (800px), or thumb (384px crop)",
    },
    {
      name: "limit",
      type: "int",
      default: 0,
      help: "Maximum photos to return in gallery order (0 = all)",
    },
  ],
  columns: ["index", "photo_key", "caption", "subject_type", "width", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError("Browser session required for zillow photos");
    let url;
    let limit;
    try {
      url = canonicalZillowListingUrl(kwargs.url);
      limit = integerInRange(kwargs.limit ?? 0, "limit", 0, 1000);
      if (!ZILLOW_PHOTO_SIZES.includes(kwargs.size)) {
        throw new Error(`size must be one of: ${ZILLOW_PHOTO_SIZES.join(", ")}`);
      }
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }

    const { pageData, photos } = await readZillowListingPhotos(page, url);
    const listing = describeZillowListing(pageData, url);
    const selected = limit > 0 ? photos.slice(0, limit) : photos;
    return selected.map((photo) => normalizePhotoRow(photo, listing, kwargs.size));
  },
});
