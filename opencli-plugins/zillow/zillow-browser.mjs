import { CommandExecutionError } from "@jackwener/opencli/errors";
import {
  collectZillowPhotos,
  detectZillowChallenge,
  detectZillowNotFound,
  detectZillowUnavailable,
  isPerimeterXCookie,
  isZillowUrl,
} from "./zillow-helpers.mjs";

/**
 * Runs inside the listing page, so it must stay self-contained: `page.evaluate`
 * serializes the function source and cannot carry module-scope bindings along.
 *
 * Zillow renders its home details page with Next.js and embeds the GraphQL
 * response the page was built from in `<script id="__NEXT_DATA__">`, under
 * `props.pageProps.componentProps.gdpClientCache` (a JSON string keyed by
 * query name, `ForSalePriorityQuery{...}` or `NotForSalePriorityQuery{...}`).
 * The entry's `property.responsivePhotosOriginalRatio` is the complete gallery
 * in display order with the CDN URL of every width bucket of each photo, and
 * `property.responsivePhotos` is the cropped ladder of the same photos. A 404
 * renders the same script with `pageProps.errorMessage` instead. Only when
 * that state is absent does the reader fall back to scraping CDN URLs out of
 * the HTML.
 */
export function readZillowListingPage() {
  var out = {
    url: location.href,
    title: document.title || "",
    body_text: "",
    hydrated: false,
    challenge: false,
    error_message: "",
    sub_app: "",
    property: null,
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
  try {
    out.challenge = !!document.querySelector("#px-captcha");
  } catch (_) {
    out.challenge = false;
  }

  var nextData = null;
  try {
    var script = document.getElementById("__NEXT_DATA__");
    nextData = script && script.textContent ? JSON.parse(script.textContent) : null;
  } catch (_) {
    nextData = null;
  }
  if (!nextData && window.__NEXT_DATA__ && typeof window.__NEXT_DATA__ === "object") {
    nextData = window.__NEXT_DATA__;
  }

  function sources(entry) {
    var list = entry && entry.mixedSources && entry.mixedSources.jpeg;
    if (!Array.isArray(list)) return [];
    var result = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].url) result.push({ url: list[i].url, width: list[i].width });
    }
    return result;
  }
  function photoSlice(list) {
    if (!Array.isArray(list)) return null;
    var result = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i] || {};
      result.push({
        caption: entry.caption,
        subjectType: entry.subjectType,
        key: entry.key,
        url: entry.url,
        mixedSources: { jpeg: sources(entry) },
      });
    }
    return result;
  }

  var pageProps = nextData && nextData.props && nextData.props.pageProps;
  if (pageProps) {
    out.hydrated = true;
    out.error_message = pageProps.errorMessage ? String(pageProps.errorMessage) : "";
    out.sub_app = pageProps.subAppName ? String(pageProps.subAppName) : "";
    var componentProps = pageProps.componentProps;
    var cache = componentProps && componentProps.gdpClientCache;
    if (typeof cache === "string") {
      try {
        cache = JSON.parse(cache);
      } catch (_) {
        cache = null;
      }
    }
    if (cache && typeof cache === "object") {
      var keys = Object.keys(cache);
      for (var k = 0; k < keys.length; k++) {
        var property = cache[keys[k]] && cache[keys[k]].property;
        if (!property || typeof property !== "object") continue;
        out.property = {
          zpid: property.zpid,
          streetAddress: property.streetAddress,
          city: property.city,
          state: property.state,
          zipcode: property.zipcode,
          address: property.address,
          homeStatus: property.homeStatus,
          hdpUrl: property.hdpUrl,
          photoCount: property.photoCount,
          mlsid: property.mlsid,
          hiResImageLink: property.hiResImageLink,
          responsivePhotosOriginalRatio: photoSlice(property.responsivePhotosOriginalRatio),
          responsivePhotos: photoSlice(property.responsivePhotos),
        };
        break;
      }
    }
  }

  var hasPhotos =
    out.property &&
    ((Array.isArray(out.property.responsivePhotosOriginalRatio) &&
      out.property.responsivePhotosOriginalRatio.length > 0) ||
      (Array.isArray(out.property.responsivePhotos) && out.property.responsivePhotos.length > 0));
  if (!hasPhotos) {
    var html = document.documentElement ? document.documentElement.outerHTML : "";
    var matches =
      html.match(
        /https?:\\?\/\\?\/photos\.zillowstatic\.com\\?\/fp\\?\/[0-9a-f]{32}-[^"'\s\\<>)]+/gi,
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
  return collectZillowPhotos(pageData).photos.length > 0;
}

async function navigateAndRead(page, url, timeoutMs) {
  const currentUrl = await page.evaluate("window.location.href || ''").catch(() => "");
  if (isZillowUrl(currentUrl)) {
    await page.goto("about:blank", { waitUntil: "none" });
  }
  await page.goto(url);

  const deadline = Date.now() + timeoutMs;
  let pageData = null;
  for (;;) {
    pageData = await page.evaluate(readZillowListingPage);
    if (
      pageData?.hydrated ||
      hasReadablePhotos(pageData) ||
      detectZillowChallenge(pageData) ||
      detectZillowUnavailable(pageData) ||
      detectZillowNotFound(pageData) ||
      Date.now() >= deadline
    ) {
      break;
    }
    await page.wait({ time: 0.5 });
  }
  return pageData;
}

/**
 * Zillow's PerimeterX sensor scores every page load and stores its verdict in
 * the `_px*`/`pxcts` cookies. A verdict written during an automated load blocks
 * the next navigation with a "Press & Hold" wall, while a visitor without those
 * cookies gets the page. Deleting only those cookies resets the verdict and
 * leaves the rest of the guardian's Zillow session alone. Returns the number of
 * cookies deleted.
 */
export async function resetPerimeterXCookies(page) {
  let cookies;
  try {
    cookies = await page.getCookies({ url: "https://www.zillow.com/" });
  } catch (_) {
    return 0;
  }
  const targets = (Array.isArray(cookies) ? cookies : []).filter(isPerimeterXCookie);
  let deleted = 0;
  for (const cookie of targets) {
    try {
      await page.cdp("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path || "/",
      });
      deleted += 1;
    } catch (_) {
      // A cookie the browser refuses to delete leaves the verdict in place; the
      // retry then reports the wall instead of looping.
    }
  }
  return deleted;
}

function isRefusedLoad(pageData) {
  return detectZillowChallenge(pageData) || detectZillowUnavailable(pageData);
}

/**
 * Navigate to the listing and poll until Zillow's page state is present (or
 * the page has settled on a challenge, error, or not-found screen). A refused
 * load is retried once after resetting the PerimeterX cookies. Leaving a Zillow
 * page first keeps the client-side router from swallowing the navigation.
 */
export async function loadZillowListingPage(page, url, { timeoutMs = 20000 } = {}) {
  let pageData = await navigateAndRead(page, url, timeoutMs);
  if (isRefusedLoad(pageData)) {
    await resetPerimeterXCookies(page);
    pageData = await navigateAndRead(page, url, timeoutMs);
  }
  return pageData;
}

export function assertReadableZillowPage(pageData, url) {
  if (detectZillowChallenge(pageData)) {
    throw new CommandExecutionError(
      "Zillow served a bot-check or access challenge; clear it in the browser and retry",
    );
  }
  if (detectZillowUnavailable(pageData)) {
    throw new CommandExecutionError(
      `Zillow refused to serve ${url} (HTTP error page); wait a moment and retry`,
    );
  }
  if (detectZillowNotFound(pageData)) {
    throw new CommandExecutionError(`Zillow has no listing page at ${url}`);
  }
}

/** Load a listing and return its gallery photos plus where they came from. */
export async function readZillowListingPhotos(page, url) {
  const pageData = await loadZillowListingPage(page, url);
  assertReadableZillowPage(pageData, url);
  const { photos, source } = collectZillowPhotos(pageData);
  if (photos.length === 0) {
    throw new CommandExecutionError(
      `Zillow exposed no listing photos at ${url}; pass a home details URL such as https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/`,
    );
  }
  return { pageData, photos, source };
}
