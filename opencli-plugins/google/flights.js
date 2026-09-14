import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  configureFlightAirports,
  parseFlightLocation,
  verifyFlightAirports,
} from "./flight-airports.mjs";
import { FLIGHT_PRICE_PATTERN_SOURCE } from "./flight-labels.mjs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CABIN_LABELS = {
  economy: "economy",
  "premium-economy": "premium economy",
  business: "business",
  first: "first",
};

function integerInRange(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CommandExecutionError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CommandExecutionError(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateDate(value, name) {
  if (!DATE_PATTERN.test(value)) {
    throw new CommandExecutionError(`${name} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new CommandExecutionError(`${name} is not a valid calendar date`);
  }
  return value;
}

async function configurePassengers(page, adults, children) {
  if (adults === 1 && children === 0) return;
  const targets = JSON.stringify({ adults, children });
  const result = await page.evaluate(`
    (async function() {
      var targets = ${targets};
      var sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
      var passengerButton = Array.from(document.querySelectorAll('button[aria-label*="passenger"]'))
        .find(function(button) {
          return /passengers?[, ]/i.test(button.getAttribute('aria-label') || '');
        });
      if (!passengerButton) {
        return {ok: false, message: 'Could not find the Google Flights passenger control'};
      }

      passengerButton.click();
      await sleep(400);

      async function setCount(selector, addLabel, removeLabel, target) {
        for (var attempt = 0; attempt < 12; attempt++) {
          var control = document.querySelector(selector);
          var current = Number(control && control.getAttribute('aria-valuenow'));
          if (!Number.isFinite(current)) return false;
          if (current === target) return true;

          var wantedLabel = current < target ? addLabel : removeLabel;
          var button = Array.from(control.querySelectorAll('button')).find(function(candidate) {
            return (candidate.getAttribute('aria-label') || '') === wantedLabel;
          });
          if (!button) return false;
          button.click();
          await sleep(250);
        }
        return false;
      }

      var adultsSet = await setCount(
        '[aria-label="Number of adult passengers"]',
        'Add adult',
        'Remove adult',
        targets.adults
      );
      var childrenSet = await setCount(
        '[aria-label="Number of children aged 2 to 11"]',
        'Add child aged 2 to 11',
        'Remove child aged 2 to 11',
        targets.children
      );
      var dialog = document.querySelector('[role="dialog"][aria-label="Number of passengers"]');
      var done = Array.from(dialog ? dialog.querySelectorAll('button') : []).find(function(button) {
        return (button.textContent || '').trim() === 'Done';
      });

      if (!adultsSet || !childrenSet || !done) {
        return {ok: false, message: 'Could not configure the requested Google Flights passengers'};
      }
      done.click();
      await sleep(500);
      return {ok: true};
    })()
  `);
  if (!result || !result.ok) {
    throw new CommandExecutionError(
      (result && result.message) || "Could not configure Google Flights passengers",
    );
  }
  await page.wait(2);
}

async function configureCabin(page, cabin) {
  if (cabin === "economy") return;
  const cabinLabel = JSON.stringify(CABIN_LABELS[cabin]);
  const result = await page.evaluate(`
    (async function() {
      var cabin = ${cabinLabel};
      var sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
      var label = document.querySelector('[aria-label^="Change seating class"]');
      var control = label && label.closest('[role="combobox"]');
      if (!control) {
        return {ok: false, message: 'Could not find the Google Flights cabin control'};
      }

      control.click();
      await sleep(400);
      var options = Array.from(document.querySelectorAll(
        'ul[aria-label="Select your preferred seating class."] li[role="option"]'
      ));
      var option = options.find(function(candidate) {
        return (candidate.innerText || '').trim().toLowerCase().startsWith(cabin);
      });
      if (!option) {
        return {ok: false, message: 'Could not select the requested Google Flights cabin'};
      }

      option.click();
      await sleep(700);
      return {ok: true};
    })()
  `);
  if (!result || !result.ok) {
    throw new CommandExecutionError(
      (result && result.message) || "Could not configure the Google Flights cabin",
    );
  }
  await page.wait(3);
}

async function normalizeFlightLocale(page, requestedUrl, currency, region) {
  const currentUrl = await page.evaluate("window.location.href");
  let normalizedUrl;
  try {
    normalizedUrl = new URL(currentUrl || requestedUrl);
  } catch {
    normalizedUrl = new URL(requestedUrl);
  }
  normalizedUrl.searchParams.set("hl", "en");
  normalizedUrl.searchParams.set("curr", currency);
  normalizedUrl.searchParams.set("gl", region);

  if (normalizedUrl.toString() !== currentUrl) {
    await page.goto(normalizedUrl.toString());
  }

  const documentLanguage = await page.evaluate(
    "(document.documentElement.getAttribute('lang') || '').toLowerCase()",
  );
  if (!documentLanguage.startsWith("en")) {
    throw new CommandExecutionError(
      `Google Flights did not honor the requested English locale (rendered ${documentLanguage || "an unknown locale"})`,
    );
  }
}

cli({
  site: "google",
  name: "flights",
  access: "read",
  description: "Search Google Flights one-way itineraries or round-trip outbound options",
  domain: "google.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    {
      name: "from",
      type: "string",
      positional: true,
      required: true,
      help: "Origin airport code, city, airport name, or comma-separated airport codes (SFO,OAK)",
    },
    {
      name: "to",
      type: "string",
      positional: true,
      required: true,
      help: "Destination airport code, city, airport name, or comma-separated airport codes (IAH,HOU)",
    },
    {
      name: "depart",
      type: "string",
      positional: true,
      required: true,
      help: "Departure date in YYYY-MM-DD format",
    },
    {
      name: "return",
      type: "string",
      help: "Return date in YYYY-MM-DD format; omit for a one-way search",
    },
    {
      name: "adults",
      type: "int",
      default: 1,
      help: "Number of adult passengers (1-9)",
    },
    {
      name: "children",
      type: "int",
      default: 0,
      help: "Number of child passengers (0-8; 9 passengers maximum in total)",
    },
    {
      name: "cabin",
      type: "string",
      default: "economy",
      choices: ["economy", "premium-economy", "business", "first"],
      help: "Cabin class used for the search and displayed prices",
    },
    {
      name: "stops",
      type: "string",
      default: "any",
      choices: ["any", "nonstop", "one-or-fewer", "two-or-fewer"],
      help: "Maximum stops on the returned leg (the outbound leg for round trips)",
    },
    {
      name: "airline",
      type: "string",
      help: "Comma-separated airline allowlist for the returned leg (outbound for round trips)",
    },
    {
      name: "max-price",
      type: "int",
      help: "Maximum displayed price; round trips use the starting total before return selection",
    },
    {
      name: "max-duration",
      type: "int",
      help: "Maximum returned-leg duration in minutes (outbound duration for round trips)",
    },
    {
      name: "sort",
      type: "string",
      default: "best",
      choices: ["best", "price", "duration", "departure", "arrival", "emissions"],
      help: "Sort by Google's ranking, displayed price, or a returned-leg field",
    },
    {
      name: "limit",
      type: "int",
      default: 10,
      help: "Maximum number of flight choices to return (1-50)",
    },
    {
      name: "currency",
      type: "string",
      default: "USD",
      help: "Three-letter display currency code (for example USD, EUR, or JPY)",
    },
    {
      name: "region",
      type: "string",
      default: "US",
      help: "Two-letter Google Flights region code",
    },
  ],
  columns: [
    "rank",
    "result_type",
    "search_type",
    "leg",
    "price",
    "currency",
    "price_basis",
    "leg_airline",
    "leg_departure",
    "leg_arrival",
    "leg_duration",
    "leg_stops",
    "leg_route",
    "leg_emissions",
    "leg_bags",
    "url",
  ],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError("Browser session required for google flights");

    let originLocation;
    let destinationLocation;
    try {
      originLocation = parseFlightLocation(kwargs.from, "from");
      destinationLocation = parseFlightLocation(kwargs.to, "to");
    } catch (error) {
      throw new CommandExecutionError(error.message);
    }
    const origin = originLocation.query;
    const destination = destinationLocation.query;
    const airportSelections = {
      origin: originLocation.airports,
      destination: destinationLocation.airports,
    };
    const hasAirportLists = Boolean(originLocation.airports || destinationLocation.airports);

    const departDate = validateDate(String(kwargs.depart || ""), "depart");
    const returnDate = kwargs.return ? validateDate(String(kwargs.return), "return") : null;
    if (returnDate && returnDate < departDate) {
      throw new CommandExecutionError("return must be on or after depart");
    }

    const adults = integerInRange(kwargs.adults, "adults", 1, 9);
    const children = integerInRange(kwargs.children, "children", 0, 8);
    if (adults + children > 9) {
      throw new CommandExecutionError("adults and children must total no more than 9");
    }

    const limit = integerInRange(kwargs.limit, "limit", 1, 50);
    const maxPrice = optionalPositiveInteger(kwargs["max-price"], "max-price");
    const maxDuration = optionalPositiveInteger(kwargs["max-duration"], "max-duration");
    const currency = String(kwargs.currency || "USD")
      .trim()
      .toUpperCase();
    const region = String(kwargs.region || "US")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new CommandExecutionError("currency must be a three-letter code");
    }
    if (!/^[A-Z]{2}$/.test(region)) {
      throw new CommandExecutionError("region must be a two-letter code");
    }

    const query = returnDate
      ? `Flights from ${origin} to ${destination} on ${departDate} through ${returnDate}`
      : `One way flights from ${origin} to ${destination} on ${departDate}`;

    const searchUrl = new URL("https://www.google.com/travel/flights");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("hl", "en");
    searchUrl.searchParams.set("curr", currency);
    searchUrl.searchParams.set("gl", region);

    await page.goto(searchUrl.toString());
    // Natural-language q searches can redirect to a canonical /search URL and
    // discard locale parameters. Reapply them before using English aria-label
    // prose or English passenger/cabin controls, then verify the rendered locale.
    await normalizeFlightLocale(page, searchUrl.toString(), currency, region);
    if (hasAirportLists) {
      try {
        await configureFlightAirports(page, airportSelections);
        // A fresh load prevents the initial single-airport cards from leaking into the combined search.
        await page.goto(await page.evaluate("window.location.href"));
        await normalizeFlightLocale(page, searchUrl.toString(), currency, region);
        await verifyFlightAirports(page, airportSelections);
      } catch (error) {
        throw new CommandExecutionError(error.message);
      }
    }
    try {
      await page.wait({
        selector: 'li.pIav2d [role="link"][aria-label]',
        timeout: 15,
      });
    } catch {
      await page.wait(3);
    }

    // Google reliably parses route and date queries, but combinations of cabin and
    // passenger phrases are inconsistent. Configure those two controls through the
    // public UI after the initial search so their prices and baggage counts are exact.
    await configurePassengers(page, adults, children);
    await configureCabin(page, kwargs.cabin);

    const airlines = String(kwargs.airline || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const extractionConfig = JSON.stringify({
      airlines,
      currency,
      limit,
      maxDuration,
      maxPrice,
      pricePattern: FLIGHT_PRICE_PATTERN_SOURCE,
      region,
      searchUrl: searchUrl.toString(),
      sort: kwargs.sort,
      stops: kwargs.stops,
      roundTrip: Boolean(returnDate),
    });

    const wrapper = await page.evaluate(`
      (function() {
        var config = ${extractionConfig};

        function numberFrom(value) {
          if (!value) return null;
          var parsed = Number(String(value).replace(/[^0-9.]/g, ''));
          return Number.isFinite(parsed) ? parsed : null;
        }

        function durationMinutes(value) {
          if (!value) return null;
          var hours = value.match(/(\\d+)\\s*hr/i);
          var minutes = value.match(/(\\d+)\\s*min/i);
          if (!hours && !minutes) return null;
          return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
        }

        function timeMinutes(value) {
          if (!value) return null;
          var match = value.match(/(\\d{1,2}):(\\d{2})\\s*([AP]M)/i);
          if (!match) return null;
          var hours = Number(match[1]) % 12;
          if (match[3].toUpperCase() === 'PM') hours += 12;
          return hours * 60 + Number(match[2]);
        }

        function stopCount(value) {
          if (!value) return null;
          if (/nonstop/i.test(value)) return 0;
          var match = value.match(/(\\d+)/);
          return match ? Number(match[1]) : null;
        }

        function stopsAllowed(value) {
          if (config.stops === 'any') return true;
          var count = stopCount(value);
          if (count === null) return false;
          if (config.stops === 'nonstop') return count === 0;
          if (config.stops === 'one-or-fewer') return count <= 1;
          if (config.stops === 'two-or-fewer') return count <= 2;
          return true;
        }

        var cards = Array.from(document.querySelectorAll('li.pIav2d'));
        if (cards.length === 0) {
          cards = Array.from(
            document.querySelectorAll('.JMc5Xc[role="link"][aria-label]')
          ).map(function(link) { return link.closest('li') || link.parentElement; });
        }

        var seenLabels = {};
        var items = cards.map(function(card, originalIndex) {
          var link = card.querySelector('.JMc5Xc[role="link"][aria-label]')
            || card.querySelector('[role="link"][aria-label]');
          if (!link) return null;
          var label = link.getAttribute('aria-label') || '';
          if (!label || seenLabels[label]) return null;
          seenLabels[label] = true;
          var text = (card.innerText || '').replace(/\\u00a0/g, ' ').trim();

          var priceMatch = label.match(new RegExp(config.pricePattern, 'i'));
          var stopsMatch = label.match(/\\.\\s*([^.]+?) flight with /i);
          var airlineMatch = label.match(/flight with (.+?)\\./i);
          var operatedMatch = label.match(/Operated by (.+?)\\./i);
          var departureMatch = label.match(/Leaves (.+?) at (.+?) on (.+?) and arrives/i);
          var arrivalMatch = label.match(/arrives at (.+?) at (.+?) on (.+?)\\./i);
          var durationMatch = label.match(/Total duration (.+?)\\./i);
          var carryOnMatch = label.match(/(\\d+) carry-on bags? included/i);
          var checkedMatch = label.match(/(\\d+) checked bags? included/i);
          var routeMatch = text.match(/\\b([A-Z]{3})\\s*[–-]\\s*([A-Z]{3})\\b/);
          var emissionsMatch = text.match(/([0-9][0-9,]*)\\s*kg CO2e(?:\\s*\\n([+-]?\\d+% emissions|Avg emissions))?/i);

          var price = priceMatch ? numberFrom(priceMatch[1]) : null;
          var duration = durationMatch ? durationMatch[1] : '';
          var airline = airlineMatch ? airlineMatch[1] : '';
          var stopsText = stopsMatch ? stopsMatch[1] : '';
          var emissionsValue = emissionsMatch ? numberFrom(emissionsMatch[1]) : null;

          return {
            _arrivalMinutes: arrivalMatch ? timeMinutes(arrivalMatch[2]) : null,
            _departureMinutes: departureMatch ? timeMinutes(departureMatch[2]) : null,
            _durationMinutes: durationMinutes(duration),
            _emissionsValue: emissionsValue,
            _originalIndex: originalIndex,
            _priceValue: price,
            _stopCount: stopCount(stopsText),
            currency: config.currency,
            leg: config.roundTrip ? 'outbound' : 'one_way',
            leg_airline: airline,
            leg_arrival: arrivalMatch ? arrivalMatch[2] + ' · ' + arrivalMatch[3] : '',
            leg_bags: (carryOnMatch ? carryOnMatch[1] : '?') + ' carry-on, '
              + (checkedMatch ? checkedMatch[1] : '?') + ' checked',
            leg_departure: departureMatch ? departureMatch[2] + ' · ' + departureMatch[3] : '',
            leg_duration: duration,
            leg_emissions: emissionsMatch
              ? emissionsMatch[1] + ' kg CO2e' + (emissionsMatch[2] ? ' · ' + emissionsMatch[2] : '')
              : '',
            leg_operated_by: operatedMatch ? operatedMatch[1] : '',
            leg_route: routeMatch ? routeMatch[1] + '–' + routeMatch[2] : '',
            leg_stops: stopsText,
            notice: config.roundTrip
              ? 'Leg fields and leg filters describe only this outbound option; price is a starting round-trip total before a return is selected.'
              : '',
            price: price,
            price_basis: config.roundTrip
              ? 'round_trip_starting_total_return_not_selected'
              : 'one_way_displayed_total',
            result_type: config.roundTrip ? 'outbound_option' : 'one_way_itinerary',
            search_type: config.roundTrip ? 'round_trip' : 'one_way',
            url: (function() {
              try {
                var resultUrl = new URL(window.location.href || config.searchUrl);
                resultUrl.searchParams.set('hl', 'en');
                resultUrl.searchParams.set('curr', config.currency);
                resultUrl.searchParams.set('gl', config.region);
                return resultUrl.toString();
              } catch (_) {
                return config.searchUrl;
              }
            })(),
          };
        }).filter(Boolean);

        var available = items.length;
        items = items.filter(function(item) {
          if (!stopsAllowed(item.leg_stops)) return false;
          if (config.maxPrice !== null
              && (item._priceValue === null || item._priceValue > config.maxPrice)) return false;
          if (config.maxDuration !== null
              && (item._durationMinutes === null || item._durationMinutes > config.maxDuration)) return false;
          if (config.airlines.length > 0) {
            var haystack = (item.leg_airline + ' ' + item.leg_operated_by).toLowerCase();
            if (!config.airlines.some(function(name) { return haystack.indexOf(name) !== -1; })) {
              return false;
            }
          }
          return true;
        });

        var sortKeys = {
          price: '_priceValue',
          duration: '_durationMinutes',
          departure: '_departureMinutes',
          arrival: '_arrivalMinutes',
          emissions: '_emissionsValue',
        };
        var sortKey = sortKeys[config.sort];
        if (sortKey) {
          items.sort(function(left, right) {
            var leftValue = left[sortKey];
            var rightValue = right[sortKey];
            if (leftValue === null && rightValue === null) return left._originalIndex - right._originalIndex;
            if (leftValue === null) return 1;
            if (rightValue === null) return -1;
            return leftValue - rightValue || left._originalIndex - right._originalIndex;
          });
        }

        items = items.slice(0, config.limit).map(function(item, index) {
          var result = {};
          Object.keys(item).forEach(function(key) {
            if (key.charAt(0) !== '_') result[key] = item[key];
          });
          result.rank = index + 1;
          return result;
        });

        return {
          available: available,
          bodyText: (document.body && document.body.innerText || '').slice(0, 2000),
          items: items,
          title: document.title,
        };
      })()
    `);

    const results = (wrapper && wrapper.items) || [];
    if (results.length === 0) {
      const pageLoaded = wrapper && wrapper.available > 0;
      const hint = pageLoaded
        ? "Google Flights returned flight choices, but none matched the requested filters"
        : "Google Flights returned no readable flight choices; verify the route and dates, or check the browser for a consent page or CAPTCHA";
      throw new CommandExecutionError(hint);
    }

    return results;
  },
});
