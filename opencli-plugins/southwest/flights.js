import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { loadSouthwestFlights, SouthwestLoginRequiredError } from "./southwest-browser.mjs";
import { FARES, STOPS, SORTS, normalizeResults, normalizeSearch } from "./southwest-helpers.mjs";

cli({
  site: "southwest",
  name: "flights",
  access: "read",
  description:
    "Search Southwest cash fares or Rapid Rewards points (outbound choices for round trips)",
  example: "opencli southwest flights OAK HOU 2026-11-13 --miles --stops nonstop -f json",
  domain: "southwest.com",
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    {
      name: "from",
      type: "string",
      positional: true,
      required: true,
      help: "Origin airport code, e.g. OAK",
    },
    {
      name: "to",
      type: "string",
      positional: true,
      required: true,
      help: "Destination airport code, e.g. HOU",
    },
    {
      name: "depart",
      type: "string",
      positional: true,
      required: true,
      help: "Departure date, YYYY-MM-DD",
    },
    {
      name: "return",
      type: "string",
      help: "Return date. Returns outbound choices, not a round-trip total",
    },
    {
      name: "miles",
      type: "bool",
      default: false,
      help: "Search Rapid Rewards points plus cash taxes (same as --points)",
    },
    {
      name: "points",
      type: "bool",
      default: false,
      help: "Search Rapid Rewards points plus cash taxes (same as --miles)",
    },
    {
      name: "adults",
      type: "int",
      default: 1,
      help: "Adult passengers (1-8). Prices remain per person",
    },
    {
      name: "fare",
      type: "string",
      choices: FARES,
      default: "all",
      help: "Fare product filter. By default, one row per available fare product",
    },
    {
      name: "stops",
      type: "string",
      choices: STOPS,
      default: "any",
      help: "Maximum stops, including stops without a plane change",
    },
    {
      name: "max-price",
      type: "string",
      help: "Maximum displayed USD fare per person. Cash searches only",
    },
    {
      name: "max-points",
      type: "int",
      help: "Maximum points per person. Requires --points or --miles",
    },
    { name: "max-miles", type: "int", help: "Alias for --max-points" },
    { name: "max-duration", type: "int", help: "Maximum outbound duration in minutes" },
    {
      name: "sort",
      type: "string",
      choices: SORTS,
      default: "best",
      help: "Southwest order, price (points then taxes for awards), duration, or departure",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      help: "Maximum fare rows (1-500), after filtering and sorting all loaded flights",
    },
    {
      name: "timeout",
      type: "int",
      default: 90,
      help: "Result-loading deadline in seconds (5-180)",
    },
  ],
  columns: [
    "rank",
    "origin",
    "destination",
    "departure_date",
    "departure",
    "arrival_date",
    "arrival",
    "duration_minutes",
    "stops",
    "fare_product",
    "price",
    "points",
    "taxes",
    "currency",
    "price_basis",
  ],
  func: async (page, args) => {
    let search;
    try {
      search = normalizeSearch(args);
    } catch (error) {
      throw new ArgumentError(error.message);
    }
    if (!page) throw new CommandExecutionError("Browser session required for southwest flights");
    try {
      return normalizeResults(await loadSouthwestFlights(page, search), search);
    } catch (error) {
      if (error instanceof SouthwestLoginRequiredError)
        throw new AuthRequiredError("southwest.com", error.message);
      throw new CommandExecutionError(error.message);
    }
  },
});
