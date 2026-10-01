// PROTOTYPE — three phone redesigns of the dashboard below 768px, switchable
// via `?variant=a|b|c` (or the floating switcher in mock mode). Not for merge.
//
// The variant is a `data-phone-variant` attribute on <html>. The phone token
// overrides in `mock/phone-variants.prototype.css` key on it, and the layout
// forks in the shell and pages read it through `usePhoneVariant`. Nothing sets
// the attribute outside mock mode, so every fork falls back to variant A,
// which is the dashboard as #584 leaves it.
import { useSyncExternalStore } from "react";

export type PhoneVariant = "a" | "b" | "c";

export const PHONE_VARIANTS: { key: PhoneVariant; name: string }[] = [
  { key: "a", name: "Today: small controls, hidden tap areas, slide-over" },
  { key: "b", name: "Scaled: 44px controls, 16px text, slide-over" },
  { key: "c", name: "Phone-native: 17px text, bottom tabs, reflowed pages" },
];

const STORAGE_KEY = "rome.prototype.phoneVariant";
const EVENT = "rome:phone-variant";
const PHONE_QUERY = "(max-width: 767px)";

function isVariant(value: string | null): value is PhoneVariant {
  return value === "a" || value === "b" || value === "c";
}

function current(): PhoneVariant {
  const value = document.documentElement.dataset.phoneVariant ?? null;
  return isVariant(value) ? value : "a";
}

/** Called once from the mock entry: URL first, then the last pick, then A. */
export function initPhoneVariant() {
  const fromUrl = new URLSearchParams(window.location.search).get("variant");
  const stored = localStorage.getItem(STORAGE_KEY);
  const variant = isVariant(fromUrl) ? fromUrl : isVariant(stored) ? stored : "a";
  document.documentElement.dataset.phoneVariant = variant;
  localStorage.setItem(STORAGE_KEY, variant);
}

export function setPhoneVariant(variant: PhoneVariant) {
  document.documentElement.dataset.phoneVariant = variant;
  localStorage.setItem(STORAGE_KEY, variant);
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
}

function subscribeVariant(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The picked variant, whatever the viewport. */
export function usePickedPhoneVariant(): PhoneVariant {
  return useSyncExternalStore(subscribeVariant, current, () => "a");
}

/**
 * The variant a layout fork should render: the pick on a phone-width
 * viewport, and A (today's layout) from 768px up, so desktop never changes.
 */
export function usePhoneVariant(): PhoneVariant {
  const picked = usePickedPhoneVariant();
  const phone = useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
  return phone ? picked : "a";
}
