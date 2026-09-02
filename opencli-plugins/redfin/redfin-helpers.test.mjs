import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRedfinPhotoFilename,
  canonicalRedfinListingUrl,
  collectRedfinPhotos,
  describeRedfinListing,
  detectRedfinChallenge,
  detectRedfinNotFound,
  formatBytes,
  integerInRange,
  isRedfinUrl,
  normalizePhotoRow,
  normalizeRedfinPhoto,
  planRedfinDownloads,
  REDFIN_PHOTO_SIZES,
  redfinListingSlug,
  redfinPhotoPosition,
  selectRedfinPhotoUrl,
  summarizeRedfinDownload,
} from "./redfin-helpers.mjs";

const CDN = "https://ssl.cdn-redfin.com/photo/8";

// Shaped like Redfin's server-rendered aboveTheFold media browser entries.
function rawPhoto(fileName, photoId, { width = 799, height = 533 } = {}) {
  return {
    photoUrls: {
      nonFullScreenPhotoUrlCompressed: `${CDN}/mbphotov3/150/genMid.${fileName}`,
      nonFullScreenPhotoUrl: `${CDN}/mbpaddedwide/150/genMid.${fileName}`,
      fullScreenPhotoUrl: `${CDN}/bigphoto/150/${fileName}`,
      lightboxListUrl: `${CDN}/bcsphoto/150/genBcs.${fileName}`,
    },
    thumbnailData: { thumbnailUrl: `${CDN}/tmbphoto/150/genTmb.${fileName}` },
    displayLevel: 1,
    dataSourceId: 8,
    photoType: "SPRITED",
    subdirectory: "150",
    fileName,
    height,
    width,
    photoId,
  };
}

function hydratedPageData() {
  return {
    url: "https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
    title: "349 Walsh Rd, Atherton, CA 94027 | MLS# ML82027150 | Redfin",
    body_text: "Buy Rent Sell 34 photos $49,680,000 5 beds 7 baths 11968 sq ft",
    hydrated: true,
    initial_info: { listingId: 211307847, propertyId: 1061461, dataSourceId: 8 },
    media_browser_info: {
      photos: [
        rawPhoto("ML82027150_2.jpg", 3108056537),
        rawPhoto("ML82027150_1_2.jpg", 3108056538),
        rawPhoto("ML82027150_2_2.jpg", 3108056539, { width: 599, height: 449 }),
      ],
      assembledAddress: "349 Walsh Rd",
      altTextForImage: "349 Walsh Rd, Atherton, CA 94027",
      dataSourceId: 8,
      previousListingPhotosCount: 0,
    },
    address_section_info: {
      assembledAddress: "349 Walsh Rd",
      city: "Atherton",
      state: "CA",
      zip: "94027",
      status: "Active",
      url: "/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
    },
    tags_by_photo_id: {
      3108056537: {
        photoId: 3108056537,
        tags: ["All", "Exterior"],
        shortCaption: "Modern architectural masterpiece",
        longCaption: "Modern architectural masterpiece with glass walls and a floating staircase.",
      },
      3108056538: {
        photoId: 3108056538,
        tags: ["All"],
        shortCaption: "  Glass entrance   with wooden door ",
        longCaption: "",
      },
    },
    html_photo_urls: [],
  };
}

test("canonicalRedfinListingUrl accepts Redfin hosts and strips tracking noise", () => {
  assert.equal(
    canonicalRedfinListingUrl(
      " https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461/?utm_source=share#photos ",
    ),
    "https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
  );
  assert.equal(
    canonicalRedfinListingUrl("redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461"),
    "https://redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
  );
  assert.equal(
    canonicalRedfinListingUrl("http://www.redfin.ca/BC/Vancouver/1-Main-St-V5T/home/12345"),
    "https://www.redfin.ca/BC/Vancouver/1-Main-St-V5T/home/12345",
  );
});

test("canonicalRedfinListingUrl rejects empty, malformed, and non-Redfin input", () => {
  assert.throws(() => canonicalRedfinListingUrl(""), /url must not be empty/);
  assert.throws(() => canonicalRedfinListingUrl("https://"), /not a valid URL/);
  assert.throws(() => canonicalRedfinListingUrl("https://www.zillow.com/homedetails/1"), /Redfin/);
  assert.throws(() => canonicalRedfinListingUrl("https://redfin.com.evil.example/x"), /Redfin/);
  assert.throws(() => canonicalRedfinListingUrl("ftp://www.redfin.com/CA/x/home/1"), /Redfin/);
});

test("isRedfinUrl recognizes Redfin origins only", () => {
  assert.equal(isRedfinUrl("https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1"), true);
  assert.equal(isRedfinUrl("https://redfin.ca/"), true);
  assert.equal(isRedfinUrl("about:blank"), false);
  assert.equal(isRedfinUrl("https://www.redfin.com.example/"), false);
  assert.equal(isRedfinUrl(""), false);
});

test("redfinListingSlug names the folder after the address slug and property id", () => {
  assert.equal(
    redfinListingSlug("https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461"),
    "349-Walsh-Rd-94027-1061461",
  );
  assert.equal(
    redfinListingSlug("https://www.redfin.com/CA/San-Francisco/1-Main-St-94105/unit-2B/home/77"),
    "1-Main-St-94105-unit-2B-77",
  );
  assert.equal(redfinListingSlug("https://www.redfin.com/home/1061461"), "redfin-1061461");
  assert.equal(
    redfinListingSlug("https://www.redfin.com/city/820/CA/Atherton"),
    "city-820-CA-Atherton",
  );
  assert.equal(redfinListingSlug("https://www.redfin.com/"), "redfin-listing");
  assert.equal(redfinListingSlug("not a url"), "redfin-listing");
});

test("redfinPhotoPosition decodes the gallery position from a CDN file name", () => {
  assert.equal(redfinPhotoPosition("ML82027150_2.jpg"), 0);
  assert.equal(redfinPhotoPosition("ML82027150_1_2.jpg"), 1);
  assert.equal(redfinPhotoPosition("ML82027150_33_2.jpg"), 33);
  assert.equal(redfinPhotoPosition("ML82050172_0.jpg"), 0);
  assert.equal(redfinPhotoPosition("genMid.ML82050172_12_0.jpg"), 12);
  assert.equal(redfinPhotoPosition("logo.svg"), null);
  assert.equal(redfinPhotoPosition(""), null);
});

test("detectRedfinChallenge and detectRedfinNotFound read the page chrome", () => {
  assert.equal(detectRedfinChallenge(hydratedPageData()), false);
  assert.equal(detectRedfinNotFound(hydratedPageData()), false);
  assert.equal(
    detectRedfinChallenge({
      title: "Access to this page has been denied.",
      body_text: "Press & Hold to confirm you are a human (and not a bot).",
    }),
    true,
  );
  assert.equal(
    detectRedfinChallenge({ title: "Redfin", body_text: "Please solve the CAPTCHA" }),
    true,
  );
  assert.equal(
    detectRedfinNotFound({
      title: "Page Not Found | Redfin",
      body_text: "Oops… lost that one. Let's get you home.",
    }),
    true,
  );
  assert.equal(detectRedfinNotFound({ title: "Redfin", body_text: "Oops… lost that one." }), true);
  assert.equal(detectRedfinChallenge(null), false);
  assert.equal(detectRedfinNotFound(undefined), false);
});

test("describeRedfinListing prefers the media browser address and stringifies ids", () => {
  assert.deepEqual(describeRedfinListing(hydratedPageData()), {
    url: "https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
    title: "349 Walsh Rd, Atherton, CA 94027 | MLS# ML82027150 | Redfin",
    address: "349 Walsh Rd, Atherton, CA 94027",
    city: "Atherton",
    state: "CA",
    zip: "94027",
    status: "Active",
    listing_id: "211307847",
    property_id: "1061461",
  });
  assert.deepEqual(describeRedfinListing({}, "https://www.redfin.com/x/home/1"), {
    url: "https://www.redfin.com/x/home/1",
    title: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    status: "",
    listing_id: "",
    property_id: "",
  });
});

test("normalizeRedfinPhoto maps every CDN variant and merges tags without the All bucket", () => {
  const photo = normalizeRedfinPhoto(
    rawPhoto("ML82027150_2.jpg", 3108056537),
    0,
    hydratedPageData().tags_by_photo_id,
  );
  assert.deepEqual(photo, {
    index: 1,
    photo_id: "3108056537",
    caption: "Modern architectural masterpiece",
    long_caption: "Modern architectural masterpiece with glass walls and a floating staircase.",
    tags: ["Exterior"],
    source_width: 799,
    source_height: 533,
    file_name: "ML82027150_2.jpg",
    urls: {
      full: `${CDN}/bigphoto/150/ML82027150_2.jpg`,
      large: `${CDN}/mbphotov3/150/genMid.ML82027150_2.jpg`,
      medium: `${CDN}/mbpaddedwide/150/genMid.ML82027150_2.jpg`,
      small: `${CDN}/bcsphoto/150/genBcs.ML82027150_2.jpg`,
      thumb: `${CDN}/tmbphoto/150/genTmb.ML82027150_2.jpg`,
    },
  });
});

test("normalizeRedfinPhoto tolerates sparse candidates", () => {
  const photo = normalizeRedfinPhoto(
    {
      photoUrls: {
        fullScreenPhotoUrl: `${CDN}/bigphoto/150/ML82027150_5_2.jpg`,
        lightboxListUrl: "x",
      },
    },
    4,
  );
  assert.equal(photo.index, 5);
  assert.equal(photo.photo_id, "");
  assert.equal(photo.caption, "");
  assert.deepEqual(photo.tags, []);
  assert.equal(photo.source_width, null);
  assert.equal(photo.source_height, null);
  assert.equal(photo.file_name, "ML82027150_5_2.jpg");
  assert.equal(photo.urls.full, `${CDN}/bigphoto/150/ML82027150_5_2.jpg`);
  assert.equal(photo.urls.small, "");
  assert.equal(photo.urls.thumb, "");
});

test("collectRedfinPhotos uses the server state gallery in display order", () => {
  const { photos, source } = collectRedfinPhotos(hydratedPageData());
  assert.equal(source, "state");
  assert.deepEqual(
    photos.map((photo) => [photo.index, photo.file_name, photo.caption, photo.tags]),
    [
      [1, "ML82027150_2.jpg", "Modern architectural masterpiece", ["Exterior"]],
      [2, "ML82027150_1_2.jpg", "Glass entrance with wooden door", []],
      [3, "ML82027150_2_2.jpg", "", []],
    ],
  );
  assert.deepEqual([photos[2].source_width, photos[2].source_height], [599, 449]);
});

test("collectRedfinPhotos drops entries without any URL and renumbers the rest", () => {
  const pageData = hydratedPageData();
  pageData.media_browser_info.photos.splice(1, 0, { photoId: 1, fileName: "broken.jpg" });
  const { photos } = collectRedfinPhotos(pageData);
  assert.deepEqual(
    photos.map((photo) => [photo.index, photo.file_name]),
    [
      [1, "ML82027150_2.jpg"],
      [2, "ML82027150_1_2.jpg"],
      [3, "ML82027150_2_2.jpg"],
    ],
  );
});

test("collectRedfinPhotos falls back to HTML CDN URLs, narrowed to one listing and ordered", () => {
  const { photos, source } = collectRedfinPhotos({
    hydrated: false,
    media_browser_info: null,
    html_photo_urls: [
      `${CDN}/bigphoto/150/ML82027150_2.jpg`,
      `${CDN}/bigphoto/150/ML82027150_33_2.jpg`,
      `${CDN}/bigphoto/150/ML82027150_1_2.jpg`,
      `${CDN}/bigphoto/150/ML82027150_2.jpg`,
      "https://ssl.cdn-redfin.com/photo/10/bigphoto/822/ML81911822_0.jpg",
      `${CDN}/bigphoto/150/ML82027150_2_2.jpg`,
      "not-a-url",
    ],
  });
  assert.equal(source, "html");
  assert.deepEqual(
    photos.map((photo) => [photo.index, photo.file_name]),
    [
      [1, "ML82027150_2.jpg"],
      [2, "ML82027150_1_2.jpg"],
      [3, "ML82027150_2_2.jpg"],
      [4, "ML82027150_33_2.jpg"],
    ],
  );
  assert.equal(photos[0].urls.full, `${CDN}/bigphoto/150/ML82027150_2.jpg`);
  assert.equal(photos[0].urls.large, "");
  assert.equal(photos[0].photo_id, "");
});

test("collectRedfinPhotos reports none when nothing is readable", () => {
  assert.deepEqual(collectRedfinPhotos({ hydrated: true, media_browser_info: { photos: [] } }), {
    photos: [],
    source: "none",
  });
  assert.deepEqual(collectRedfinPhotos(null), { photos: [], source: "none" });
});

test("selectRedfinPhotoUrl honors the requested size and falls back to the largest available", () => {
  const photo = normalizeRedfinPhoto(rawPhoto("ML82027150_2.jpg", 1), 0);
  assert.deepEqual(selectRedfinPhotoUrl(photo, "thumb"), {
    url: `${CDN}/tmbphoto/150/genTmb.ML82027150_2.jpg`,
    size: "thumb",
  });
  const fullOnly = normalizeRedfinPhoto(
    { photoUrls: { fullScreenPhotoUrl: `${CDN}/bigphoto/150/ML82027150_2.jpg` } },
    0,
  );
  assert.deepEqual(selectRedfinPhotoUrl(fullOnly, "large"), {
    url: `${CDN}/bigphoto/150/ML82027150_2.jpg`,
    size: "full",
  });
  assert.deepEqual(selectRedfinPhotoUrl({ urls: {} }, "full"), { url: "", size: "" });
  assert.deepEqual(REDFIN_PHOTO_SIZES, ["full", "large", "medium", "small", "thumb"]);
});

test("buildRedfinPhotoFilename pads by gallery size and marks non-full variants", () => {
  assert.equal(
    buildRedfinPhotoFilename({
      url: `${CDN}/bigphoto/150/ML82027150_2.jpg`,
      index: 1,
      total: 34,
      size: "full",
    }),
    "01-ML82027150_2.jpg",
  );
  assert.equal(
    buildRedfinPhotoFilename({
      url: `${CDN}/bigphoto/150/ML82027150_33_2.jpg`,
      index: 34,
      total: 34,
      size: "full",
    }),
    "34-ML82027150_33_2.jpg",
  );
  assert.equal(
    buildRedfinPhotoFilename({
      url: `${CDN}/bigphoto/150/ML82027150_2.jpg`,
      index: 7,
      total: 120,
      size: "full",
    }),
    "007-ML82027150_2.jpg",
  );
  assert.equal(
    buildRedfinPhotoFilename({
      url: `${CDN}/mbphotov3/150/genMid.ML82027150_2.jpg`,
      index: 1,
      total: 3,
      size: "large",
    }),
    "01-large-genMid.ML82027150_2.jpg",
  );
  assert.equal(
    buildRedfinPhotoFilename({
      url: "https://ssl.cdn-redfin.com/",
      index: 2,
      total: 2,
      size: "full",
    }),
    "02-photo.jpg",
  );
  assert.equal(
    buildRedfinPhotoFilename({
      url: "https://ssl.cdn-redfin.com/photo/8/bigphoto/150/we%20ird%20name.PNG",
      index: 1,
      total: 1,
      size: "full",
    }),
    "01-we-ird-name.PNG",
  );
});

test("planRedfinDownloads applies the limit and names files consistently", () => {
  const { photos } = collectRedfinPhotos(hydratedPageData());
  const plan = planRedfinDownloads(photos, { size: "full", limit: 2 });
  assert.deepEqual(
    plan.map((item) => [item.index, item.file_name, item.size_variant, item.url]),
    [
      [1, "01-ML82027150_2.jpg", "full", `${CDN}/bigphoto/150/ML82027150_2.jpg`],
      [2, "02-ML82027150_1_2.jpg", "full", `${CDN}/bigphoto/150/ML82027150_1_2.jpg`],
    ],
  );
  assert.deepEqual(plan[0].tags, ["Exterior"]);
  assert.equal(plan[0].caption, "Modern architectural masterpiece");
  const all = planRedfinDownloads(photos, { size: "medium" });
  assert.equal(all.length, 3);
  assert.equal(all[2].file_name, "03-medium-genMid.ML82027150_2_2.jpg");
  const unplannable = planRedfinDownloads([{ ...photos[0], urls: {} }], { size: "full" });
  assert.deepEqual([unplannable[0].url, unplannable[0].file_name], ["", ""]);
});

test("formatBytes renders human-friendly sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(68514), "66.9 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
  assert.equal(formatBytes(157286400), "150 MB");
  assert.equal(formatBytes(-1), "");
  assert.equal(formatBytes("nope"), "");
});

test("summarizeRedfinDownload reports success and failure rows", () => {
  const { photos } = collectRedfinPhotos(hydratedPageData());
  const listing = describeRedfinListing(hydratedPageData());
  const [item] = planRedfinDownloads(photos, { size: "full" });
  assert.deepEqual(
    summarizeRedfinDownload(
      item,
      { success: true, size: 68514 },
      { listing, file: "/tmp/out/01-ML82027150_2.jpg" },
    ),
    {
      index: 1,
      status: "success",
      size: "66.9 KB",
      bytes: 68514,
      file: "/tmp/out/01-ML82027150_2.jpg",
      error: "",
      photo_id: "3108056537",
      caption: "Modern architectural masterpiece",
      tags: "Exterior",
      source_width: 799,
      source_height: 533,
      size_variant: "full",
      url: `${CDN}/bigphoto/150/ML82027150_2.jpg`,
      address: "349 Walsh Rd, Atherton, CA 94027",
      listing_url: "https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
    },
  );
  const failed = summarizeRedfinDownload(
    item,
    { success: false, size: 0, error: "HTTP 404" },
    { listing, file: "/tmp/out/01-ML82027150_2.jpg" },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.size, "");
  assert.equal(failed.bytes, 0);
  assert.equal(failed.file, "");
  assert.equal(failed.error, "HTTP 404");
  assert.equal(summarizeRedfinDownload(item, undefined).error, "unknown error");
});

test("normalizePhotoRow flattens a photo for the photos command", () => {
  const { photos } = collectRedfinPhotos(hydratedPageData());
  const listing = describeRedfinListing(hydratedPageData());
  assert.deepEqual(normalizePhotoRow(photos[0], listing, "large"), {
    index: 1,
    photo_id: "3108056537",
    caption: "Modern architectural masterpiece",
    tags: "Exterior",
    source_width: 799,
    source_height: 533,
    url: `${CDN}/mbphotov3/150/genMid.ML82027150_2.jpg`,
    size_variant: "large",
    thumbnail_url: `${CDN}/tmbphoto/150/genTmb.ML82027150_2.jpg`,
    full_url: `${CDN}/bigphoto/150/ML82027150_2.jpg`,
    long_caption: "Modern architectural masterpiece with glass walls and a floating staircase.",
    address: "349 Walsh Rd, Atherton, CA 94027",
    listing_url: "https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461",
  });
});

test("integerInRange validates command limits", () => {
  assert.equal(integerInRange("5", "limit", 0, 1000), 5);
  assert.equal(integerInRange(0, "limit", 0, 1000), 0);
  assert.throws(() => integerInRange("1.5", "limit", 0, 1000), /limit must be an integer/);
  assert.throws(() => integerInRange(-1, "limit", 0, 1000), /between 0 and 1000/);
  assert.throws(() => integerInRange("abc", "limit", 0, 1000), /limit must be an integer/);
});
