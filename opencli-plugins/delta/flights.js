import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { loadDeltaFlights, DeltaLoginRequiredError } from "./delta-browser.mjs";
import { CABINS, normalizeResults, normalizeSearch, SORTS, STOPS } from "./delta-helpers.mjs";

cli({
  site: "delta",
  name: "flights",
  access: "read",
  description: "Search Delta cash fares or SkyMiles awards (outbound choices for round trips)",
  example: "opencli delta flights SFO JFK 2026-11-13 --miles --stops nonstop -f json",
  domain: "delta.com",
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
      help: "Origin airport code, e.g. SFO",
    },
    {
      name: "to",
      type: "string",
      positional: true,
      required: true,
      help: "Destination airport code, e.g. IAH",
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
      help: "Return date, YYYY-MM-DD. Returns outbound choices, not a selected round trip",
    },
    {
      name: "miles",
      type: "bool",
      default: false,
      help: "Search SkyMiles award miles plus cash taxes. Uses the current browser session",
    },
    {
      name: "adults",
      type: "int",
      default: 1,
      help: "Adult travelers (1-9). Fares remain per person",
    },
    {
      name: "cabin",
      type: "string",
      default: "economy",
      choices: CABINS,
      help: "Filter actual fare cabins. Comfort is not Premium Select",
    },
    {
      name: "stops",
      type: "string",
      default: "any",
      choices: STOPS,
      help: "Maximum stops on the outbound leg",
    },
    {
      name: "max-price",
      type: "string",
      help: "Maximum displayed cash fare in USD. Not valid with --miles",
    },
    {
      name: "max-miles",
      type: "int",
      help: "Maximum displayed award miles per person. Requires --miles",
    },
    { name: "max-duration", type: "int", help: "Maximum outbound duration in minutes" },
    {
      name: "exclude-mixed-cabin",
      type: "bool",
      default: false,
      help: "Exclude offers with different cabins across segments",
    },
    {
      name: "sort",
      type: "string",
      default: "best",
      choices: SORTS,
      help: "Delta order, price (standard miles then taxes for awards), duration, or departure",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      help: "Maximum fare rows (1-500), after filtering and sorting all flights",
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
    "miles",
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
    if (!page) throw new CommandExecutionError("Browser session required for delta flights");
    try {
      const data = await loadDeltaFlights(page, search);
      return normalizeResults(data, search);
    } catch (error) {
      if (error instanceof DeltaLoginRequiredError)
        throw new AuthRequiredError("delta.com", error.message);
      throw new CommandExecutionError(error.message);
    }
  },
});
