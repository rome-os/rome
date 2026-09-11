import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AaLoginRequiredError, loadAaFlights } from "./aa-browser.mjs";
import { FARES, STOPS, SORTS, normalizeResults, normalizeSearch } from "./aa-helpers.mjs";

cli({
  site: "aa",
  name: "flights",
  access: "read",
  description:
    "Search American Airlines cash fares or AAdvantage miles (outbound choices for round trips)",
  example: "opencli aa flights SFO DFW 2026-11-13 --miles --stops nonstop -f json",
  domain: "aa.com",
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
      help: "Destination airport code, e.g. DFW",
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
      help: "Return date. Returns outbound choices with starting round-trip prices, not finalized itineraries",
    },
    {
      name: "miles",
      type: "bool",
      default: false,
      help: "Search AAdvantage miles plus cash taxes instead of cash fares",
    },
    {
      name: "adults",
      type: "int",
      default: 1,
      help: "Adult passengers (1-9). Prices remain per person",
    },
    {
      name: "fare",
      type: "string",
      choices: FARES,
      default: "all",
      help: "Filter displayed cash fare group or award cabin. Cash Business/First uses premium",
    },
    {
      name: "stops",
      type: "string",
      choices: STOPS,
      default: "any",
      help: "Maximum outbound stops",
    },
    { name: "max-price", type: "string", help: "Maximum displayed USD fare per person. Cash only" },
    {
      name: "max-miles",
      type: "int",
      help: "Maximum displayed miles per person. Requires --miles",
    },
    { name: "max-duration", type: "int", help: "Maximum outbound duration in minutes" },
    {
      name: "sort",
      type: "string",
      choices: SORTS,
      default: "best",
      help: "AA order, price (miles then taxes for awards), duration, or departure",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      help: "Maximum fare rows (1-500), after filtering and sorting the displayed flights",
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
    if (!page) throw new CommandExecutionError("Browser session required for aa flights");
    try {
      return normalizeResults(await loadAaFlights(page, search), search);
    } catch (error) {
      if (error instanceof AaLoginRequiredError)
        throw new AuthRequiredError("aa.com", error.message);
      throw new CommandExecutionError(error.message);
    }
  },
});
