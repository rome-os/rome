import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZillowPhotoFilename,
  canonicalZillowListingUrl,
  collectZillowPhotos,
  describeZillowListing,
  detectZillowChallenge,
  detectZillowNotFound,
  detectZillowUnavailable,
  formatBytes,
  integerInRange,
  isPerimeterXCookie,
  isZillowUrl,
  normalizePhotoRow,
  normalizeZillowPhoto,
  planZillowDownloads,
  selectZillowPhotoUrl,
  summarizeZillowDownload,
  ZILLOW_PHOTO_SIZES,
  zillowListingSlug,
  zillowPhotoKey,
  zillowVariantWidth,
  zillowZpidFromUrl,
} from "./zillow-helpers.mjs";

const CDN = "https://photos.zillowstatic.com/fp";
const KEY_1 = "40a2df03a9e1e7ce67de59c614683f5f";
const KEY_2 = "daad1a3d4a0c9190ab21e0a88199523b";
const KEY_3 = "255bf622fd4c024591f530b133942a65";

// Shaped like Zillow's `responsivePhotosOriginalRatio` entries.
function rawOriginal(key, { caption = "", subjectType = null, withUrl = true } = {}) {
  const entry = {
    caption,
    subjectType,
    mixedSources: {
      jpeg: [
        { url: `${CDN}/${key}-d_d.jpg`, width: 800 },
        { url: `${CDN}/${key}-o_a.jpg`, width: 1024 },
        { url: `${CDN}/${key}-uncropped_scaled_within_1344_1008.jpg`, width: 1344 },
        { url: `${CDN}/${key}-uncropped_scaled_within_1536_1152.jpg`, width: 1536 },
      ],
    },
    key,
  };
  if (withUrl) entry.url = `${CDN}/${key}-p_d.jpg`;
  return entry;
}

// Shaped like Zillow's `responsivePhotos` entries (the cropped ladder).
function rawCropped(key, { caption = "" } = {}) {
  return {
    caption,
    subjectType: null,
    url: `${CDN}/${key}-p_d.jpg`,
    mixedSources: {
      jpeg: [192, 384, 576, 768, 960, 1152, 1344, 1536].map((width) => ({
        url: `${CDN}/${key}-cc_ft_${width}.jpg`,
        width,
      })),
    },
  };
}

function hydratedPageData() {
  return {
    url: "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
    title: "349 Walsh Rd, Atherton, CA 94027 | MLS #ML82027150 | Zillow",
    body_text: "Skip main navigation Buy Rent Sell See all 34 photos $49,680,000 349 Walsh Rd",
    hydrated: true,
    challenge: false,
    error_message: "",
    sub_app: "for-sale-page-sub-app",
    property: {
      zpid: 15598337,
      streetAddress: "349 Walsh Rd",
      city: "Atherton",
      state: "CA",
      zipcode: "94027",
      address: { streetAddress: "349 Walsh Rd", zipcode: "94027", city: "Atherton", state: "CA" },
      homeStatus: "FOR_SALE",
      hdpUrl: "/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
      photoCount: 3,
      mlsid: "ML82027150",
      hiResImageLink: `${CDN}/${KEY_1}-p_f.jpg`,
      responsivePhotosOriginalRatio: [
        rawOriginal(KEY_1, {
          caption: "Modern architectural masterpiece",
          subjectType: "EXTERIOR",
        }),
        rawOriginal(KEY_2, { caption: "  Glass entrance   with wooden door " }),
        rawOriginal(KEY_3, { withUrl: false }),
      ],
      responsivePhotos: [rawCropped(KEY_1), rawCropped(KEY_2), rawCropped(KEY_3)],
    },
    html_photo_urls: [],
  };
}

test("canonicalZillowListingUrl accepts Zillow hosts and strips tracking noise", () => {
  assert.equal(
    canonicalZillowListingUrl(
      " https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/?utm_source=share#photos ",
    ),
    "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
  );
  assert.equal(
    canonicalZillowListingUrl(
      "zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid",
    ),
    "https://zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
  );
  assert.equal(
    canonicalZillowListingUrl(
      "http://www.zillow.com/homes/31-Rittenhouse-Ave-Atherton-CA-94027_rb",
    ),
    "https://www.zillow.com/homes/31-Rittenhouse-Ave-Atherton-CA-94027_rb/",
  );
});

test("canonicalZillowListingUrl rejects empty, malformed, and non-Zillow input", () => {
  assert.throws(() => canonicalZillowListingUrl(""), /url must not be empty/);
  assert.throws(() => canonicalZillowListingUrl("https://"), /not a valid URL/);
  assert.throws(
    () => canonicalZillowListingUrl("https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1"),
    /Zillow/,
  );
  assert.throws(() => canonicalZillowListingUrl("https://zillow.com.evil.example/x"), /Zillow/);
  assert.throws(
    () => canonicalZillowListingUrl("ftp://www.zillow.com/homedetails/1_zpid/"),
    /Zillow/,
  );
});

test("isZillowUrl recognizes Zillow origins only", () => {
  assert.equal(isZillowUrl("https://www.zillow.com/homedetails/x/15598337_zpid/"), true);
  assert.equal(isZillowUrl("https://zillow.com/"), true);
  assert.equal(isZillowUrl("about:blank"), false);
  assert.equal(isZillowUrl("https://www.zillow.com.example/"), false);
  assert.equal(isZillowUrl("https://photos.zillowstatic.com/fp/x.jpg"), false);
  assert.equal(isZillowUrl(""), false);
});

test("isPerimeterXCookie matches only the PerimeterX cookie family", () => {
  for (const name of ["_px3", "_pxvid", "pxcts", "_pxhd", "_pxde", "_pxff"]) {
    assert.equal(isPerimeterXCookie({ name }), true, name);
  }
  for (const name of ["zguid", "zgsession", "JSESSIONID", "AWSALB", "px", "", undefined]) {
    assert.equal(isPerimeterXCookie({ name }), false, String(name));
  }
  assert.equal(isPerimeterXCookie(null), false);
});

test("zillowZpidFromUrl reads the zpid segment", () => {
  assert.equal(
    zillowZpidFromUrl(
      "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
    ),
    "15598337",
  );
  assert.equal(zillowZpidFromUrl("https://www.zillow.com/homedetails/1_zpid"), "1");
  assert.equal(zillowZpidFromUrl("https://www.zillow.com/homes/31-Rittenhouse-Ave_rb/"), "");
  assert.equal(zillowZpidFromUrl("not a url"), "");
});

test("zillowListingSlug names the folder after the address slug and zpid", () => {
  assert.equal(
    zillowListingSlug(
      "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
    ),
    "349-Walsh-Rd-Atherton-CA-94027-15598337",
  );
  assert.equal(
    zillowListingSlug(
      "https://www.zillow.com/homedetails/1-Main-St-APT-2B-San-Francisco-CA-94105/77_zpid/",
    ),
    "1-Main-St-APT-2B-San-Francisco-CA-94105-77",
  );
  assert.equal(
    zillowListingSlug("https://www.zillow.com/homedetails/15598337_zpid/"),
    "zillow-15598337",
  );
  assert.equal(
    zillowListingSlug("https://www.zillow.com/homes/31-Rittenhouse-Ave-Atherton-CA-94027_rb/"),
    "homes-31-Rittenhouse-Ave-Atherton-CA-94027_rb",
  );
  assert.equal(zillowListingSlug("https://www.zillow.com/"), "zillow-listing");
  assert.equal(zillowListingSlug("not a url"), "zillow-listing");
});

test("zillowPhotoKey and zillowVariantWidth decode CDN file names", () => {
  assert.equal(zillowPhotoKey(`${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`), KEY_1);
  assert.equal(zillowPhotoKey(`${CDN}/${KEY_1.toUpperCase()}-p_f.jpg`), KEY_1);
  assert.equal(zillowPhotoKey(`${CDN}/${KEY_1}.jpg`), KEY_1);
  assert.equal(zillowPhotoKey("https://photos.zillowstatic.com/fp/logo.svg"), "");
  assert.equal(zillowPhotoKey(""), "");
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`), 1536);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-uncropped_scaled_within_1344_1008.webp`), 1344);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-cc_ft_768.jpg`), 768);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-o_a.jpg`), 1024);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-d_d.jpg`), 800);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-p_f.jpg`), 1024);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-p_d.jpg`), 400);
  assert.equal(zillowVariantWidth(`${CDN}/${KEY_1}-unknown.jpg`), 0);
});

test("detectZillowChallenge and detectZillowNotFound read the page chrome and state", () => {
  assert.equal(detectZillowChallenge(hydratedPageData()), false);
  assert.equal(detectZillowNotFound(hydratedPageData()), false);
  assert.equal(
    detectZillowChallenge({
      title: "Access to this page has been denied",
      body_text: "Press & Hold to confirm you are a human (and not a bot). Reference ID a18b9dc0",
    }),
    true,
  );
  assert.equal(detectZillowChallenge({ title: "", body_text: "", challenge: true }), true);
  assert.equal(
    detectZillowChallenge({ title: "Zillow", body_text: "Please solve the CAPTCHA" }),
    true,
  );
  assert.equal(
    detectZillowNotFound({
      title: "",
      body_text:
        "Skip main navigation Buy Rent Sell Uh oh, something broke. Error 404 - page not found.",
      hydrated: true,
      error_message: "Error 404 - page not found.",
      sub_app: "error-page-subapp",
    }),
    true,
  );
  assert.equal(detectZillowNotFound({ title: "Page Not Found | Zillow", body_text: "" }), true);
  assert.equal(
    detectZillowNotFound({ title: "", body_text: "", error_message: "Not Found" }),
    true,
  );
  assert.equal(detectZillowChallenge(null), false);
  assert.equal(detectZillowNotFound(undefined), false);
});

test("detectZillowUnavailable recognizes Chrome's error page for a refused load", () => {
  assert.equal(detectZillowUnavailable(hydratedPageData()), false);
  assert.equal(
    detectZillowUnavailable({
      url: "chrome-error://chromewebdata/",
      title: "www.zillow.com",
      body_text:
        "This page isn’t working www.zillow.com is currently unable to handle this request. HTTP ERROR 503 Reload",
    }),
    true,
  );
  assert.equal(
    detectZillowUnavailable({ url: "https://www.zillow.com/x/", body_text: "HTTP ERROR 502" }),
    true,
  );
  assert.equal(
    detectZillowUnavailable({ url: "https://www.zillow.com/x/", body_text: "HTTP ERROR 404" }),
    false,
  );
  assert.equal(detectZillowUnavailable(null), false);
});

test("describeZillowListing assembles the address and prefers the canonical hdpUrl", () => {
  assert.deepEqual(describeZillowListing(hydratedPageData()), {
    url: "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
    title: "349 Walsh Rd, Atherton, CA 94027 | MLS #ML82027150 | Zillow",
    address: "349 Walsh Rd, Atherton, CA 94027",
    street: "349 Walsh Rd",
    city: "Atherton",
    state: "CA",
    zip: "94027",
    status: "for sale",
    zpid: "15598337",
    mls_id: "ML82027150",
    photo_count: 3,
  });
  assert.deepEqual(
    describeZillowListing(
      {
        url: "https://www.zillow.com/homes/31-Rittenhouse-Ave_rb/",
        property: { hdpUrl: "/homedetails/31-Rittenhouse-Ave-Atherton-CA-94027/15580183_zpid/" },
      },
      "https://www.zillow.com/x/",
    ).url,
    "https://www.zillow.com/homedetails/31-Rittenhouse-Ave-Atherton-CA-94027/15580183_zpid/",
  );
  assert.deepEqual(describeZillowListing({}, "https://www.zillow.com/homedetails/77_zpid/"), {
    url: "https://www.zillow.com/homedetails/77_zpid/",
    title: "",
    address: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    status: "",
    zpid: "77",
    mls_id: "",
    photo_count: null,
  });
});

test("normalizeZillowPhoto orders both ladders widest first and keeps the key", () => {
  const photo = normalizeZillowPhoto(
    rawOriginal(KEY_1, { caption: "Modern architectural masterpiece", subjectType: "EXTERIOR" }),
    0,
    rawCropped(KEY_1),
  );
  assert.equal(photo.index, 1);
  assert.equal(photo.photo_key, KEY_1);
  assert.equal(photo.caption, "Modern architectural masterpiece");
  assert.equal(photo.subject_type, "EXTERIOR");
  assert.deepEqual(
    photo.original.map((source) => source.width),
    [1536, 1344, 1024, 800],
  );
  assert.equal(photo.original[0].url, `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`);
  assert.deepEqual(
    photo.cropped.map((source) => source.width),
    [1536, 1344, 1152, 960, 768, 576, 384, 192],
  );
});

test("normalizeZillowPhoto tolerates sparse candidates", () => {
  const photo = normalizeZillowPhoto(
    { mixedSources: { jpeg: [{ url: `${CDN}/${KEY_2}-o_a.jpg`, width: 1024 }, { url: "x" }] } },
    4,
  );
  assert.equal(photo.index, 5);
  assert.equal(photo.photo_key, KEY_2);
  assert.equal(photo.caption, "");
  assert.equal(photo.subject_type, "");
  assert.deepEqual(photo.original, [{ url: `${CDN}/${KEY_2}-o_a.jpg`, width: 1024 }]);
  assert.deepEqual(photo.cropped, []);
  const croppedOnly = normalizeZillowPhoto(null, 0, rawCropped(KEY_3, { caption: "Kitchen" }));
  assert.equal(croppedOnly.photo_key, KEY_3);
  assert.equal(croppedOnly.caption, "Kitchen");
  assert.deepEqual(croppedOnly.original, []);
  assert.equal(croppedOnly.cropped.length, 8);
});

test("collectZillowPhotos uses the page state gallery in display order", () => {
  const { photos, source } = collectZillowPhotos(hydratedPageData());
  assert.equal(source, "state");
  assert.deepEqual(
    photos.map((photo) => [photo.index, photo.photo_key, photo.caption, photo.subject_type]),
    [
      [1, KEY_1, "Modern architectural masterpiece", "EXTERIOR"],
      [2, KEY_2, "Glass entrance with wooden door", ""],
      [3, KEY_3, "", ""],
    ],
  );
  assert.equal(photos[2].cropped[0].url, `${CDN}/${KEY_3}-cc_ft_1536.jpg`);
});

test("collectZillowPhotos drops entries without any URL and renumbers the rest", () => {
  const pageData = hydratedPageData();
  pageData.property.responsivePhotosOriginalRatio.splice(1, 0, { caption: "broken", key: "nope" });
  pageData.property.responsivePhotos.splice(1, 0, {});
  const { photos } = collectZillowPhotos(pageData);
  assert.deepEqual(
    photos.map((photo) => [photo.index, photo.photo_key]),
    [
      [1, KEY_1],
      [2, KEY_2],
      [3, KEY_3],
    ],
  );
});

test("collectZillowPhotos falls back to the cropped ladder when the original-ratio list is absent", () => {
  const pageData = hydratedPageData();
  pageData.property.responsivePhotosOriginalRatio = null;
  const { photos, source } = collectZillowPhotos(pageData);
  assert.equal(source, "state");
  assert.deepEqual(
    photos.map((photo) => [
      photo.index,
      photo.photo_key,
      photo.original.length,
      photo.cropped.length,
    ]),
    [
      [1, KEY_1, 0, 8],
      [2, KEY_2, 0, 8],
      [3, KEY_3, 0, 8],
    ],
  );
});

test("collectZillowPhotos falls back to HTML CDN URLs, one photo per key in order of appearance", () => {
  const { photos, source } = collectZillowPhotos({
    hydrated: false,
    property: null,
    html_photo_urls: [
      `${CDN}/${KEY_1}-cc_ft_384.jpg`,
      `${CDN}/${KEY_1}-p_d.jpg`,
      `${CDN}/${KEY_2}-cc_ft_768.jpg`,
      `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`,
      `${CDN}/${KEY_1}-cc_ft_384.jpg`,
      `${CDN}/${KEY_2}-o_a.jpg`,
      "https://photos.zillowstatic.com/fp/logo.svg",
      "not-a-url",
    ],
  });
  assert.equal(source, "html");
  assert.deepEqual(
    photos.map((photo) => [photo.index, photo.photo_key, photo.caption]),
    [
      [1, KEY_1, ""],
      [2, KEY_2, ""],
    ],
  );
  assert.deepEqual(photos[0].original, [
    { url: `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`, width: 1536 },
    { url: `${CDN}/${KEY_1}-p_d.jpg`, width: 400 },
  ]);
  assert.deepEqual(photos[0].cropped, [{ url: `${CDN}/${KEY_1}-cc_ft_384.jpg`, width: 384 }]);
  assert.deepEqual(photos[1].original, [{ url: `${CDN}/${KEY_2}-o_a.jpg`, width: 1024 }]);
});

test("collectZillowPhotos reports none when nothing is readable", () => {
  assert.deepEqual(collectZillowPhotos({ hydrated: true, property: { responsivePhotos: [] } }), {
    photos: [],
    source: "none",
  });
  assert.deepEqual(collectZillowPhotos({ hydrated: true, property: null, html_photo_urls: [] }), {
    photos: [],
    source: "none",
  });
  assert.deepEqual(collectZillowPhotos(null), { photos: [], source: "none" });
});

test("selectZillowPhotoUrl maps each size to its width bucket and falls back sensibly", () => {
  const photo = normalizeZillowPhoto(rawOriginal(KEY_1), 0, rawCropped(KEY_1));
  assert.deepEqual(selectZillowPhotoUrl(photo, "full"), {
    url: `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`,
    width: 1536,
  });
  assert.deepEqual(selectZillowPhotoUrl(photo, "large"), {
    url: `${CDN}/${KEY_1}-uncropped_scaled_within_1344_1008.jpg`,
    width: 1344,
  });
  assert.deepEqual(selectZillowPhotoUrl(photo, "medium"), {
    url: `${CDN}/${KEY_1}-o_a.jpg`,
    width: 1024,
  });
  assert.deepEqual(selectZillowPhotoUrl(photo, "small"), {
    url: `${CDN}/${KEY_1}-d_d.jpg`,
    width: 800,
  });
  assert.deepEqual(selectZillowPhotoUrl(photo, "thumb"), {
    url: `${CDN}/${KEY_1}-cc_ft_384.jpg`,
    width: 384,
  });

  // Only a 1024 bucket published: small takes the narrowest bucket above its target.
  const mediumOnly = normalizeZillowPhoto(
    { mixedSources: { jpeg: [{ url: `${CDN}/${KEY_1}-o_a.jpg`, width: 1024 }] } },
    0,
  );
  assert.deepEqual(selectZillowPhotoUrl(mediumOnly, "full"), {
    url: `${CDN}/${KEY_1}-o_a.jpg`,
    width: 1024,
  });
  assert.deepEqual(selectZillowPhotoUrl(mediumOnly, "small"), {
    url: `${CDN}/${KEY_1}-o_a.jpg`,
    width: 1024,
  });
  // No cropped ladder: thumb falls back to the original-ratio ladder.
  assert.deepEqual(selectZillowPhotoUrl(mediumOnly, "thumb"), {
    url: `${CDN}/${KEY_1}-o_a.jpg`,
    width: 1024,
  });
  // No original-ratio ladder: full falls back to the widest crop.
  const croppedOnly = normalizeZillowPhoto(null, 0, rawCropped(KEY_1));
  assert.deepEqual(selectZillowPhotoUrl(croppedOnly, "full"), {
    url: `${CDN}/${KEY_1}-cc_ft_1536.jpg`,
    width: 1536,
  });
  assert.deepEqual(selectZillowPhotoUrl({ original: [], cropped: [] }, "full"), {
    url: "",
    width: 0,
  });
  assert.deepEqual(ZILLOW_PHOTO_SIZES, ["full", "large", "medium", "small", "thumb"]);
});

test("buildZillowPhotoFilename pads by gallery size and marks non-full variants", () => {
  assert.equal(
    buildZillowPhotoFilename({
      url: `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`,
      key: KEY_1,
      index: 1,
      total: 34,
      size: "full",
    }),
    `01-${KEY_1}.jpg`,
  );
  assert.equal(
    buildZillowPhotoFilename({
      url: `${CDN}/${KEY_1}-o_a.jpg`,
      key: KEY_1,
      index: 34,
      total: 34,
      size: "full",
    }),
    `34-${KEY_1}.jpg`,
  );
  assert.equal(
    buildZillowPhotoFilename({
      url: `${CDN}/${KEY_1}-o_a.jpg`,
      key: KEY_1,
      index: 7,
      total: 120,
      size: "full",
    }),
    `007-${KEY_1}.jpg`,
  );
  assert.equal(
    buildZillowPhotoFilename({
      url: `${CDN}/${KEY_1}-uncropped_scaled_within_1344_1008.webp`,
      key: KEY_1,
      index: 1,
      total: 3,
      size: "large",
    }),
    `01-large-${KEY_1}.webp`,
  );
  assert.equal(
    buildZillowPhotoFilename({
      url: "https://photos.zillowstatic.com/fp/we%20ird%20name.PNG",
      key: "",
      index: 1,
      total: 1,
      size: "full",
    }),
    "01-we-ird-name.png",
  );
  assert.equal(
    buildZillowPhotoFilename({
      url: "https://photos.zillowstatic.com/",
      key: "",
      index: 2,
      total: 2,
      size: "full",
    }),
    "02-photo.jpg",
  );
});

test("planZillowDownloads applies the limit and names files consistently", () => {
  const { photos } = collectZillowPhotos(hydratedPageData());
  const plan = planZillowDownloads(photos, { size: "full", limit: 2 });
  assert.deepEqual(
    plan.map((item) => [item.index, item.file_name, item.width, item.url]),
    [
      [1, `01-${KEY_1}.jpg`, 1536, `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`],
      [2, `02-${KEY_2}.jpg`, 1536, `${CDN}/${KEY_2}-uncropped_scaled_within_1536_1152.jpg`],
    ],
  );
  assert.equal(plan[0].caption, "Modern architectural masterpiece");
  assert.equal(plan[0].subject_type, "EXTERIOR");
  const all = planZillowDownloads(photos, { size: "medium" });
  assert.equal(all.length, 3);
  assert.equal(all[2].file_name, `03-medium-${KEY_3}.jpg`);
  assert.equal(all[2].url, `${CDN}/${KEY_3}-o_a.jpg`);
  const thumbs = planZillowDownloads(photos, { size: "thumb", limit: 1 });
  assert.equal(thumbs[0].file_name, `01-thumb-${KEY_1}.jpg`);
  assert.equal(thumbs[0].width, 384);
  const unplannable = planZillowDownloads([{ ...photos[0], original: [], cropped: [] }], {
    size: "full",
  });
  assert.deepEqual([unplannable[0].url, unplannable[0].file_name], ["", ""]);
});

test("formatBytes renders human-friendly sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(85171), "83.2 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
  assert.equal(formatBytes(157286400), "150 MB");
  assert.equal(formatBytes(-1), "");
  assert.equal(formatBytes("nope"), "");
});

test("summarizeZillowDownload reports success and failure rows", () => {
  const { photos } = collectZillowPhotos(hydratedPageData());
  const listing = describeZillowListing(hydratedPageData());
  const [item] = planZillowDownloads(photos, { size: "full" });
  assert.deepEqual(
    summarizeZillowDownload(
      item,
      { success: true, size: 85171 },
      { listing, file: `/tmp/out/01-${KEY_1}.jpg` },
    ),
    {
      index: 1,
      status: "success",
      size: "83.2 KB",
      bytes: 85171,
      file: `/tmp/out/01-${KEY_1}.jpg`,
      error: "",
      photo_key: KEY_1,
      caption: "Modern architectural masterpiece",
      subject_type: "EXTERIOR",
      width: 1536,
      url: `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`,
      address: "349 Walsh Rd, Atherton, CA 94027",
      zpid: "15598337",
      listing_url:
        "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
    },
  );
  const failed = summarizeZillowDownload(
    item,
    { success: false, size: 0, error: "HTTP 404" },
    { listing, file: `/tmp/out/01-${KEY_1}.jpg` },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.size, "");
  assert.equal(failed.bytes, 0);
  assert.equal(failed.file, "");
  assert.equal(failed.error, "HTTP 404");
  assert.equal(summarizeZillowDownload(item, undefined).error, "unknown error");
});

test("normalizePhotoRow flattens a photo for the photos command", () => {
  const { photos } = collectZillowPhotos(hydratedPageData());
  const listing = describeZillowListing(hydratedPageData());
  assert.deepEqual(normalizePhotoRow(photos[0], listing, "large"), {
    index: 1,
    photo_key: KEY_1,
    caption: "Modern architectural masterpiece",
    subject_type: "EXTERIOR",
    width: 1344,
    url: `${CDN}/${KEY_1}-uncropped_scaled_within_1344_1008.jpg`,
    thumbnail_url: `${CDN}/${KEY_1}-cc_ft_384.jpg`,
    full_url: `${CDN}/${KEY_1}-uncropped_scaled_within_1536_1152.jpg`,
    address: "349 Walsh Rd, Atherton, CA 94027",
    zpid: "15598337",
    listing_url: "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/",
  });
});

test("integerInRange validates command limits", () => {
  assert.equal(integerInRange("5", "limit", 0, 1000), 5);
  assert.equal(integerInRange(0, "limit", 0, 1000), 0);
  assert.throws(() => integerInRange("1.5", "limit", 0, 1000), /limit must be an integer/);
  assert.throws(() => integerInRange(-1, "limit", 0, 1000), /between 0 and 1000/);
  assert.throws(() => integerInRange("abc", "limit", 0, 1000), /limit must be an integer/);
});
