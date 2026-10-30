/**
 * Starts (or joins) the download of the /chat route's chunks. The chunk name
 * is what `route-preload-plugin.ts` looks up to write the HTML preload links.
 * Kept out of `App.tsx` so that file exports only its component and stays a
 * Fast Refresh boundary.
 */
export const loadFreePage = () =>
  import(/* webpackChunkName: "route-chat" */ "./pages/free/FreePage");
