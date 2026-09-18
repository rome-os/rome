import { CommandExecutionError } from "@jackwener/opencli/errors";
import {
  buildYelpSearchUrl,
  canonicalYelpBusinessUrl,
  cleanText,
  yelpBusinessAlias,
} from "./yelp-helpers.mjs";

export function assertReadableYelpPage(payload, surface) {
  if (payload?.challenge) {
    throw new CommandExecutionError(
      `Yelp served a CAPTCHA or access challenge during ${surface}; clear it in the browser and retry`,
    );
  }
  if (payload?.logged_out_block) {
    throw new CommandExecutionError(
      `Yelp unexpectedly required a login during ${surface}; this command only uses logged-out pages`,
    );
  }
}

export async function waitForYelpSelector(page, selector) {
  try {
    await page.wait({ selector, timeout: 15 });
  } catch {
    await page.wait(2);
  }
}

export async function extractYelpSearchCandidates(page) {
  return page.evaluate(`
    (function() {
      function clean(value) {
        return typeof value === 'string'
          ? value.replace(/[\\u00a0\\u202f]/g, ' ').replace(/\\s+/g, ' ').trim()
          : '';
      }

      function unique(values) {
        var seen = {};
        return values.map(clean).filter(function(value) {
          var key = value.toLowerCase();
          if (!value || seen[key]) return false;
          seen[key] = true;
          return true;
        });
      }

      function canonicalBusinessHref(value) {
        try {
          var url = new URL(value, location.origin);
          if (url.pathname === '/adredir') {
            var redirect = url.searchParams.get('redirect_url');
            if (redirect) url = new URL(redirect);
          }
          if (!/^(?:www\\.)?yelp\\.com$/i.test(url.hostname) || !/^\\/biz\\/[^/]+/.test(url.pathname)) {
            return '';
          }
          return 'https://www.yelp.com' + url.pathname.replace(/\\/$/, '');
        } catch (_) {
          return '';
        }
      }

      var candidates = Array.from(document.querySelectorAll('[data-testid="serp-ia-card"]'))
        .map(function(card) {
          var nameLink = card.querySelector('[data-traffic-crawl-id="SearchResultBizName"] a[href]')
            || card.querySelector('h3 a[href]');
          var ratingNode = card.querySelector('[role="img"][aria-label*="star rating"]');
          var cardText = clean(card.innerText || '');
          var reviewMatch = cardText.match(/\\(([0-9][0-9.,]*\\s*[KMB]?)\\s+reviews?\\)/i);
          var rankMatch = clean(nameLink && nameLink.closest('h3') && nameLink.closest('h3').innerText)
            .match(/^(\\d+)\\s*[.·]/);
          var links = Array.from(card.querySelectorAll('a[href]'));
          var categories = unique(links.filter(function(link) {
            var href = link.getAttribute('href') || '';
            return /^\\/search\\?/.test(href) && (link.closest('p') || link.querySelector('p'));
          }).map(function(link) { return link.textContent; }));
          var spans = unique(Array.from(card.querySelectorAll('span')).map(function(span) {
            return span.textContent;
          }));
          var price = spans.find(function(text) { return /^[$]{1,4}$/.test(text); }) || '';
          var openStatus = spans.find(function(text) {
            return /^(?:Open|Closed|Temporarily closed)\\b/i.test(text) && text.length < 80;
          }) || '';
          var neighborhood = spans.find(function(text) {
            if (text.length > 100 || categories.indexOf(text) !== -1) return false;
            if (/^(?:\\d+(?:\\.\\d+)?|\\([0-9]|[$]{1,4}$)/.test(text)) return false;
            if (/^(?:Open|Closed|Temporarily closed|until |more$|Get Directions|Order|Reserve)/i.test(text)) return false;
            if (/\\breviews?\\b|\\bstar rating\\b|On their website/i.test(text)) return false;
            return /[A-Za-z]/.test(text);
          }) || '';
          var paragraphs = Array.from(card.querySelectorAll('p')).map(function(node) {
            return clean(node.innerText || node.textContent);
          }).filter(Boolean);
          var snippet = paragraphs.find(function(text) {
            return categories.indexOf(text) === -1 && (text.length > 80 || /[“”"]/.test(text));
          }) || '';
          var services = unique(Array.from(card.querySelectorAll('a, button, [role="button"]'))
            .map(function(node) { return clean(node.innerText || node.textContent); })
            .filter(function(text) {
              return /^(?:Order|Start Order|Reserve|Join Waitlist|Request a Quote|Get Directions)$/i.test(text);
            }));
          var image = card.querySelector('img[src]');
          var orderNode = card.querySelector('[data-linkouturl]');
          var traffic = clean(card.getAttribute('data-traffic-crawl-id'));
          var sponsored = !/OrganicBusinessResult/i.test(traffic)
            || Boolean((card.closest('li') && /Sponsored Results?/i.test(clean(card.closest('li').previousElementSibling && card.closest('li').previousElementSibling.innerText))));
          return {
            rank: rankMatch ? Number(rankMatch[1]) : null,
            name: clean(nameLink && nameLink.textContent),
            url: canonicalBusinessHref(nameLink && nameLink.getAttribute('href')),
            rating_label: clean(ratingNode && ratingNode.getAttribute('aria-label')),
            review_text: reviewMatch ? reviewMatch[1] : '',
            price: price,
            categories: categories,
            neighborhood: neighborhood,
            open_status: openStatus,
            services: services,
            snippet: snippet,
            is_sponsored: sponsored,
            image_url: image && image.src || '',
            order_url: clean(orderNode && orderNode.getAttribute('data-linkouturl')),
          };
        })
        .filter(function(candidate) { return candidate.name && candidate.url; });

      var bodyText = clean(document.body && document.body.innerText || '');
      return {
        candidates: candidates,
        challenge: /captcha|are you a human|unusual activity|access denied|temporarily blocked/i.test(bodyText)
          || /captcha|access denied/i.test(document.title || ''),
        logged_out_block: /log in to continue|sign in to continue/i.test(bodyText),
        no_results: /No results for|did not match any businesses/i.test(bodyText),
        title: document.title || '',
        url: location.href || '',
        body_text: bodyText.slice(0, 2500),
      };
    })()
  `);
}

export async function resolveYelpBusiness(page, business, location) {
  let direct;
  try {
    direct = canonicalYelpBusinessUrl(business);
  } catch (error) {
    throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
  }
  if (direct) return { url: direct, alias: yelpBusinessAlias(direct), name: null };

  const normalizedLocation = cleanText(location);
  if (!normalizedLocation) {
    throw new CommandExecutionError(
      "location is required when business is a name; alternatively pass a Yelp business alias or /biz/ URL",
    );
  }
  const searchUrl = buildYelpSearchUrl({ query: business, location: normalizedLocation });
  await page.goto(searchUrl);
  await waitForYelpSelector(page, '[data-testid="serp-ia-card"], main');
  const payload = await extractYelpSearchCandidates(page);
  assertReadableYelpPage(payload, "business resolution");
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const candidate = candidates.find((item) => !item.is_sponsored) || candidates[0];
  if (!candidate?.url) {
    throw new CommandExecutionError(
      `Yelp returned no business matching "${cleanText(business)}" near "${normalizedLocation}"`,
    );
  }
  return {
    url: canonicalYelpBusinessUrl(candidate.url),
    alias: yelpBusinessAlias(candidate.url),
    name: cleanText(candidate.name) || null,
  };
}

export async function navigateFreshYelpPage(page, url) {
  const currentUrl = await page.evaluate("window.location.href || ''").catch(() => "");
  if (/^https:\/\/(?:www\.)?yelp\.com\/(?:search|biz)\b/i.test(currentUrl)) {
    await page.goto(new URL("/", url).href, { waitUntil: "none" });
  }
  await page.goto(url);
}

export async function extractYelpBusiness(page) {
  return page.evaluate(`
    (function() {
      function clean(value) {
        return typeof value === 'string'
          ? value.replace(/[\\u00a0\\u202f]/g, ' ').replace(/\\s+/g, ' ').trim()
          : '';
      }
      function jsonLd() {
        return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map(function(script) { try { return JSON.parse(script.textContent); } catch (_) { return null; } })
          .filter(Boolean);
      }
      function apolloState() {
        var script = Array.from(document.querySelectorAll('script[type="application/json"]'))
          .find(function(node) { return /^<!--\\s*{&quot;ROOT_QUERY&quot;/.test(node.textContent || ''); });
        if (!script) return null;
        try {
          var textarea = document.createElement('textarea');
          textarea.innerHTML = (script.textContent || '').replace(/^<!--/, '').replace(/-->$/, '');
          return JSON.parse(textarea.value);
        } catch (_) { return null; }
      }
      function deref(state, value) {
        return value && value.__ref && state && state[value.__ref] || value || null;
      }
      function field(object, name, predicate) {
        if (!object) return null;
        var keys = Object.keys(object).filter(function(key) {
          return key === name || key.indexOf(name + '(') === 0;
        });
        if (predicate) {
          var preferred = keys.map(function(key) { return object[key]; }).find(predicate);
          if (preferred !== undefined) return preferred;
        }
        if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
        return keys.length ? object[keys[0]] : null;
      }
      function photoUrl(photo) {
        if (!photo || !photo.photoUrl) return '';
        var key = Object.keys(photo.photoUrl).find(function(value) { return value.indexOf('ORIGINAL') !== -1; })
          || Object.keys(photo.photoUrl).find(function(value) { return value.indexOf('url') === 0; });
        return clean(key && photo.photoUrl[key]);
      }

      var state = apolloState();
      var business = null;
      if (state) {
        var rootBusiness = Object.keys(state.ROOT_QUERY || {}).find(function(key) {
          return key.indexOf('business(') === 0;
        });
        business = deref(state, rootBusiness && state.ROOT_QUERY[rootBusiness]);
        if (!business) {
          var businessKey = Object.keys(state).find(function(key) { return key.indexOf('Business:') === 0; });
          business = businessKey && state[businessKey];
        }
      }
      var locationValue = deref(state, business && business.location);
      var categories = (business && business.categories || []).map(function(value) {
        return deref(state, value);
      }).filter(Boolean).map(function(value) { return clean(value.title); }).filter(Boolean);
      var operationHours = field(business, 'operationHours');
      var today = operationHours && operationHours.regularHoursMergedWithSpecialHoursForCurrentDay;
      var week = operationHours && operationHours.regularHoursMergedWithSpecialHoursForCurrentWeek || [];
      var claim = field(business, 'claimability', function(value) {
        return value && typeof value.isClaimed === 'boolean';
      });
      var properties = field(business, 'organizedProperties') || [];
      var activeAttributes = properties.flatMap(function(section) {
        return section.properties || [];
      }).filter(function(property) { return property && property.isActive === true; })
        .map(function(property) { return clean(property.displayText); }).filter(Boolean);
      var resources = field(business, 'externalResources') || {};
      var photo = deref(state, business && business.primaryPhoto);
      var inspections = field(business, 'healthInspections') || [];
      var summary = field(business, 'summary');
      var candidate = {
        name: clean(business && business.name),
        rating: field(business, 'rating'),
        review_count: field(business, 'reviewCount'),
        price: clean(field(business, 'priceRange') && field(business, 'priceRange').display),
        categories: categories,
        claimed: claim && typeof claim.isClaimed === 'boolean' ? claim.isClaimed : null,
        open_now: today && typeof today.isCurrentlyOpen === 'boolean' ? today.isCurrentlyOpen : null,
        hours_today: today && today.hours || [],
        weekly_hours: week.map(function(day) {
          return clean(day.dayOfWeekShort) + ': ' + ((day.hours || []).join(', ') || 'Closed');
        }),
        address: clean(locationValue && locationValue.address && locationValue.address.formatted),
        neighborhoods: locationValue && locationValue.neighborhoods || [],
        phone: clean(field(business, 'phoneNumber') && field(business, 'phoneNumber').formatted)
          || clean(field(business, 'meteredPhoneNumber') && field(business, 'meteredPhoneNumber').phoneText),
        website: clean(resources.website && resources.website.url),
        menu_url: clean(resources.menu && resources.menu.url),
        attributes: activeAttributes,
        health_score: clean(inspections[0] && inspections[0].formattedScore),
        about: clean(business && business.specialties) || clean(summary && summary.text),
        photo_url: photoUrl(photo),
        business_id: clean(business && business.encid),
        url: location.href || '',
      };

      var structured = jsonLd().find(function(value) {
        return ['LocalBusiness', 'FoodEstablishment', 'Restaurant'].indexOf(value['@type']) !== -1;
      });
      if (structured) {
        candidate.name = candidate.name || clean(structured.name);
        candidate.rating = candidate.rating == null && structured.aggregateRating
          ? structured.aggregateRating.ratingValue : candidate.rating;
        candidate.review_count = candidate.review_count == null && structured.aggregateRating
          ? structured.aggregateRating.reviewCount : candidate.review_count;
        candidate.price = candidate.price || clean(structured.priceRange);
        candidate.phone = candidate.phone || clean(structured.telephone);
        candidate.categories = candidate.categories.length ? candidate.categories
          : (Array.isArray(structured.servesCuisine) ? structured.servesCuisine : [structured.servesCuisine]).filter(Boolean);
        candidate.weekly_hours = candidate.weekly_hours.length ? candidate.weekly_hours
          : (Array.isArray(structured.openingHours) ? structured.openingHours : [structured.openingHours]).filter(Boolean);
        if (!candidate.address && structured.address) {
          candidate.address = clean([
            structured.address.streetAddress,
            structured.address.addressLocality,
            structured.address.addressRegion,
            structured.address.postalCode,
          ].filter(Boolean).join(', '));
        }
        if (!candidate.photo_url) {
          var image = Array.isArray(structured.image) ? structured.image[0] : structured.image;
          candidate.photo_url = clean(image && (image.contentUrl || image.url) || image);
        }
        if (!candidate.attributes.length && Array.isArray(structured.amenityFeature)) {
          candidate.attributes = structured.amenityFeature.filter(function(item) {
            return item && item.value === true;
          }).map(function(item) { return clean(item.name); }).filter(Boolean);
        }
      }
      var bodyText = clean(document.body && document.body.innerText || '');
      return {
        candidate: candidate,
        challenge: /captcha|are you a human|unusual activity|access denied|temporarily blocked/i.test(bodyText)
          || /captcha|access denied/i.test(document.title || ''),
        logged_out_block: /log in to continue|sign in to continue/i.test(bodyText),
        title: document.title || '',
        url: location.href || '',
        body_text: bodyText.slice(0, 2500),
      };
    })()
  `);
}

export async function extractYelpReviews(page) {
  return page.evaluate(`
    (function() {
      function clean(value) {
        return typeof value === 'string'
          ? value.replace(/[\\u00a0\\u202f]/g, ' ').replace(/\\s+/g, ' ').trim()
          : '';
      }
      function reactionMap(root) {
        var result = {};
        Array.from(root.querySelectorAll('[role="button"][aria-label*="reaction"]')).forEach(function(button) {
          var label = clean(button.getAttribute('aria-label'));
          var match = label.match(/^(.+?)\\s*\\((\\d+)\\s+reactions?\\)$/i);
          if (match) result[match[1].toLowerCase().replace(/\\s+/g, '_')] = Number(match[2]);
        });
        return result;
      }
      var reviews = Array.from(document.querySelectorAll('li')).filter(function(item) {
        return item.querySelector('a[href^="/user_details?userid="]')
          && item.querySelector('[role="img"][aria-label*="star rating"]')
          && item.querySelector('p[class*="comment__"]');
      }).map(function(item) {
        var authorLinks = Array.from(item.querySelectorAll('a[href^="/user_details?userid="]'));
        var authorLink = authorLinks.find(function(link) { return clean(link.textContent); }) || authorLinks[0];
        var region = authorLink && authorLink.closest('[role="region"]');
        var dateNode = Array.from(item.querySelectorAll('span')).find(function(span) {
          var text = clean(span.textContent);
          return /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},\\s+\\d{4}$/i.test(text);
        });
        var eliteNode = region && Array.from(region.querySelectorAll('a, span')).find(function(node) {
          return /^Elite\\s+\\d{2}$/i.test(clean(node.textContent));
        });
        var photoLink = Array.from(item.querySelectorAll('a[href*="/biz_photos/"]')).find(function(link) {
          return /\\d+\\s+photos?/i.test(clean(link.textContent));
        });
        var rating = item.querySelector('[role="img"][aria-label*="star rating"]');
        var content = item.querySelector('p[class*="comment__"]');
        var locationNode = region && region.querySelector('[data-testid="UserPassportInfoTextContainer"]');
        return {
          author: clean(authorLink && authorLink.textContent),
          author_location: clean(locationNode && locationNode.textContent),
          author_url: authorLink && new URL(authorLink.getAttribute('href'), location.origin).href || '',
          elite: clean(eliteNode && eliteNode.textContent),
          rating_label: clean(rating && rating.getAttribute('aria-label')),
          date: clean(dateNode && dateNode.textContent),
          text: clean(content && content.innerText),
          photo_count: clean(photoLink && photoLink.textContent),
          reactions: reactionMap(item),
        };
      });
      var bodyText = clean(document.body && document.body.innerText || '');
      return {
        reviews: reviews,
        challenge: /captcha|are you a human|unusual activity|access denied|temporarily blocked/i.test(bodyText)
          || /captcha|access denied/i.test(document.title || ''),
        logged_out_block: /log in to continue|sign in to continue/i.test(bodyText),
        no_results: /No reviews found|doesn't have any reviews/i.test(bodyText),
        title: document.title || '',
        url: location.href || '',
        body_text: bodyText.slice(0, 2500),
      };
    })()
  `);
}

export async function extractYelpPhotos(page) {
  return page.evaluate(`
    (function() {
      function clean(value) {
        return typeof value === 'string'
          ? value.replace(/[\\u00a0\\u202f]/g, ' ').replace(/\\s+/g, ' ').trim()
          : '';
      }
      var structured = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(function(script) { try { return JSON.parse(script.textContent); } catch (_) { return null; } })
        .filter(Boolean)
        .find(function(value) { return value['@type'] === 'MediaGallery'; });
      var elements = structured && structured.mainEntity && structured.mainEntity.itemListElement || [];
      var photos = elements.map(function(element) {
        var item = element.item || element;
        return {
          url: clean(item.contentUrl || item.url),
          thumbnail_url: clean(item.thumbnailUrl),
          caption: clean(item.caption),
          author: clean(item.creator && item.creator.name || item.author && item.author.name),
          upload_date: clean(item.uploadDate),
          width: item.width || null,
          height: item.height || null,
        };
      }).filter(function(item) { return item.url; });
      var selected = document.querySelector('[role="tab"][aria-selected="true"]');
      var heading = Array.from(document.querySelectorAll('h1, h2')).map(function(node) {
        return clean(node.textContent);
      }).find(function(text) { return /^Photos and videos for /i.test(text); }) || '';
      var bodyText = clean(document.body && document.body.innerText || '');
      return {
        photos: photos,
        business: heading.replace(/^Photos and videos for /i, ''),
        selected_tab: clean(selected && selected.textContent),
        challenge: /captcha|are you a human|unusual activity|access denied|temporarily blocked/i.test(bodyText)
          || /captcha|access denied/i.test(document.title || ''),
        logged_out_block: /log in to continue|sign in to continue/i.test(bodyText),
        title: document.title || '',
        url: location.href || '',
        body_text: bodyText.slice(0, 2500),
      };
    })()
  `);
}

export async function extractYelpMenu(page) {
  return page.evaluate(`
    (function() {
      function clean(value) {
        return typeof value === 'string'
          ? value.replace(/[\\u00a0\\u202f]/g, ' ').replace(/\\s+/g, ' ').trim()
          : '';
      }
      function apolloState() {
        var script = Array.from(document.querySelectorAll('script[type="application/json"]'))
          .find(function(node) { return /^<!--\\s*{&quot;ROOT_QUERY&quot;/.test(node.textContent || ''); });
        if (!script) return null;
        try {
          var textarea = document.createElement('textarea');
          textarea.innerHTML = (script.textContent || '').replace(/^<!--/, '').replace(/-->$/, '');
          return JSON.parse(textarea.value);
        } catch (_) { return null; }
      }
      function deref(state, value) {
        return value && value.__ref && state && state[value.__ref] || value || null;
      }
      function field(object, name) {
        if (!object) return null;
        if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
        var key = Object.keys(object).find(function(value) { return value.indexOf(name + '(') === 0; });
        return key ? object[key] : null;
      }
      var state = apolloState();
      var business = null;
      if (state) {
        var key = Object.keys(state).find(function(value) { return value.indexOf('Business:') === 0; });
        business = key && state[key];
      }
      var resources = field(business, 'externalResources') || {};
      var menuUrl = clean(resources.menu && resources.menu.url);
      var hostedItems = state ? Object.values(state).filter(function(value) {
        return value && typeof value === 'object' && /MenuItem/i.test(value.__typename || '')
          && clean(value.name || value.title);
      }).map(function(value) {
        var price = value.price || value.displayPrice || value.formattedPrice || '';
        return {
          item_type: 'menu_item',
          name: clean(value.name || value.title),
          section: clean(value.sectionName || value.categoryName),
          description: clean(value.description),
          price: clean(typeof price === 'object' ? price.display || price.formatted : price),
          photo_count: null,
          review_count: null,
          photo_url: clean(value.photoUrl && (value.photoUrl.url || value.photoUrl) || value.imageUrl),
        };
      }) : [];

      var lists = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(function(script) { try { return JSON.parse(script.textContent); } catch (_) { return null; } })
        .filter(Boolean);
      var popular = lists.find(function(value) {
        return value['@type'] === 'ItemList' && /^Popular (?:Dishes|Drinks|Items)/i.test(clean(value.name));
      });
      var countMap = {};
      Array.from(document.querySelectorAll('[class*="dishPassport__"]')).forEach(function(card) {
        var image = card.querySelector('img[alt]');
        var name = clean(image && image.getAttribute('alt'))
          || clean(card.querySelector('p') && card.querySelector('p').textContent);
        var text = clean(card.innerText || '');
        var photos = text.match(/([0-9][0-9,.]*\\s*[KMB]?)\\s+Photos?/i);
        var reviews = text.match(/([0-9][0-9,.]*\\s*[KMB]?)\\s+Reviews?/i);
        if (name) countMap[name.toLowerCase()] = {
          photo_count: photos ? photos[1] : null,
          review_count: reviews ? reviews[1] : null,
        };
      });
      var popularItems = (popular && popular.itemListElement || []).map(function(element) {
        var item = element.item || element;
        var name = clean(item.caption || item.name);
        var counts = countMap[name.toLowerCase()] || {};
        return {
          item_type: 'popular_item',
          name: name,
          section: clean(popular.name),
          description: '',
          price: '',
          photo_count: counts.photo_count || null,
          review_count: counts.review_count || null,
          photo_url: clean(item.contentUrl || item.url || item.thumbnailUrl),
        };
      }).filter(function(item) { return item.name; });
      var rows = hostedItems.length ? hostedItems : popularItems;
      var bodyText = clean(document.body && document.body.innerText || '');
      return {
        business: clean(business && business.name),
        menu_url: menuUrl,
        items: rows,
        source_type: hostedItems.length ? 'yelp_menu' : popularItems.length ? 'popular_items' : 'external_only',
        challenge: /captcha|are you a human|unusual activity|access denied|temporarily blocked/i.test(bodyText)
          || /captcha|access denied/i.test(document.title || ''),
        logged_out_block: /log in to continue|sign in to continue/i.test(bodyText),
        title: document.title || '',
        url: location.href || '',
        body_text: bodyText.slice(0, 2500),
      };
    })()
  `);
}
