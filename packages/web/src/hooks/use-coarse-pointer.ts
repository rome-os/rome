import { COARSE_POINTER_QUERY } from "@/lib/media-query";
import { useMediaQuery } from "./use-media-query";

/**
 * True on touch-first devices (phones, tablets), false on desktop.
 * Live-updates if the pointer capabilities change (e.g. responsive devtools,
 * convertible laptops switching modes).
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
