import { CommandExecutionError } from "@jackwener/opencli/errors";
import {
  collectRedfinPhotos,
  detectRedfinChallenge,
  detectRedfinNotFound,
  isRedfinUrl,
} from "./redfin-helpers.mjs";

/**
 * Runs inside the listing page, so it must stay self-contained: `page.evaluate`
 * serializes the function source and cannot carry module-scope bindings along.
 *
 * Redfin server-renders every data-API response the page needs into
 * `window.__reactServerState.InitialContext["ReactServerAgent.cache"].dataCache`,
 * keyed by API path. The media browser payload there is the complete gallery in
 * display order, with the CDN URL for every variant of each photo; the photo
 * tags payload adds captions and room tags per photo id. Only when that state is
 * absent does the reader fall back to scraping full-size CDN URLs out of the HTML.
 */
export function readRedfinListingPage() {
  var out = {
    url: location.href,
    title: document.title || "",
    body_text: "",
    hydrated: false,
    initial_info: null,
    media_browser_info: null,
    address_section_info: null,
    tags_by_photo_id: null,
    html_photo_urls: [],
  };
  try {
    out.body_text = String((document.body && document.body.innerText) || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  } catch (_) {
    out.body_text = "";
  }

  var state = window.__reactServerState;
  var context = state && state.InitialContext;
  var agent = context && context["ReactServerAgent.cache"];
  var cache = agent && agent.dataCache;

  function payloadOf(pattern) {
    if (!cache) return null;
    var keys = Object.keys(cache);
    for (var i = 0; i < keys.length; i++) {
      if (!pattern.test(keys[i])) continue;
      var entry = cache[keys[i]];
      var body = entry && entry.res && entry.res.body;
      if (body && body.payload) return body.payload;
    }
    return null;
  }

  if (cache) {
    out.hydrated = true;
    var initialInfo = payloadOf(/\/home\/details\/initialInfo(?:\?|$)/);
    if (initialInfo) {
      out.initial_info = {
        listingId: initialInfo.listingId,
        propertyId: initialInfo.propertyId,
        dataSourceId: initialInfo.dataSourceId,
        marketName: initialInfo.marketName,
        responseCode: initialInfo.responseCode,
      };
    }
    var aboveTheFold = payloadOf(/\/home\/details\/aboveTheFold(?:\?|$)/);
    var media = aboveTheFold && aboveTheFold.mediaBrowserInfo;
    if (media) {
      out.media_browser_info = {
        photos: Array.isArray(media.photos) ? media.photos : [],
        assembledAddress: media.assembledAddress,
        altTextForImage: media.altTextForImage,
        dataSourceId: media.dataSourceId,
        previousListingPhotosCount: media.previousListingPhotosCount,
      };
    }
    var address = aboveTheFold && aboveTheFold.addressSectionInfo;
    if (address) {
      out.address_section_info = {
        assembledAddress: address.streetAddress && address.streetAddress.assembledAddress,
        city: address.city,
        state: address.state,
        zip: address.zip,
        status: address.status && address.status.displayValue,
        url: address.url,
      };
    }
    var tags = payloadOf(/\/photoTagsAndCaptions\//);
    out.tags_by_photo_id = (tags && tags.tagsByPhotoId) || null;
  }

  var hasPhotos =
    out.media_browser_info &&
    Array.isArray(out.media_browser_info.photos) &&
    out.media_browser_info.photos.length > 0;
  if (!hasPhotos) {
    var html = document.documentElement ? document.documentElement.outerHTML : "";
    var matches =
      html.match(
        /https?:\\?\/\\?\/ssl\.cdn-redfin\.com\\?\/photo\\?\/\d+\\?\/bigphoto\\?\/[^"'\s\\<>]+/g,
      ) || [];
    var seen = {};
    for (var j = 0; j < matches.length; j++) {
      var url = matches[j].replace(/\\\//g, "/");
      if (!seen[url]) {
        seen[url] = true;
        out.html_photo_urls.push(url);
      }
    }
  }
  return out;
}

function hasReadablePhotos(pageData) {
  return (
    (Array.isArray(pageData?.media_browser_info?.photos) &&
      pageData.media_browser_info.photos.length > 0) ||
    (Array.isArray(pageData?.html_photo_urls) && pageData.html_photo_urls.length > 0)
  );
}

/**
 * Navigate to the listing and poll until Redfin's server state is present (or
 * the page has settled on a challenge / not-found screen). Leaving a Redfin page
 * first keeps the client-side router from swallowing the navigation.
 */
export async function loadRedfinListingPage(page, url, { timeoutMs = 20000 } = {}) {
  const currentUrl = await page.evaluate("window.location.href || ''").catch(() => "");
  if (isRedfinUrl(currentUrl)) {
    await page.goto("about:blank", { waitUntil: "none" });
  }
  await page.goto(url);

  const deadline = Date.now() + timeoutMs;
  let pageData = null;
  for (;;) {
    pageData = await page.evaluate(readRedfinListingPage);
    if (
      pageData?.hydrated ||
      hasReadablePhotos(pageData) ||
      detectRedfinChallenge(pageData) ||
      detectRedfinNotFound(pageData) ||
      Date.now() >= deadline
    ) {
      break;
    }
    await page.wait({ time: 0.5 });
  }
  return pageData;
}

export function assertReadableRedfinPage(pageData, url) {
  if (detectRedfinChallenge(pageData)) {
    throw new CommandExecutionError(
      "Redfin served a bot-check or access challenge; clear it in the browser and retry",
    );
  }
  if (detectRedfinNotFound(pageData)) {
    throw new CommandExecutionError(`Redfin has no listing page at ${url}`);
  }
}

/** Load a listing and return its gallery photos plus where they came from. */
export async function readRedfinListingPhotos(page, url) {
  const pageData = await loadRedfinListingPage(page, url);
  assertReadableRedfinPage(pageData, url);
  const { photos, source } = collectRedfinPhotos(pageData);
  if (photos.length === 0) {
    throw new CommandExecutionError(
      `Redfin exposed no listing photos at ${url}; pass a home listing URL such as https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461`,
    );
  }
  return { pageData, photos, source };
}
