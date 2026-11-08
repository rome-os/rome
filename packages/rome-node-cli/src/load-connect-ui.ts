/**
 * Loads the status screen on the production build of React.
 *
 * Nothing sets NODE_ENV for `rome-node connect`, so react and react-reconciler would load their
 * development builds. With React 19.3 those record several performance.measure entries per render,
 * which Node never clears. The screen renders every second, so the heap grows until the process
 * runs out of memory after days. The build is picked when the modules are evaluated, so NODE_ENV
 * only has to be "production" during this import.
 *
 * It is restored right after because programs run through remote exec inherit this process's
 * environment, and a lasting NODE_ENV=production would change them (pnpm install skips
 * devDependencies, for one). Call it before the host connects, so no program can start meanwhile.
 */
export async function loadConnectUi(): Promise<typeof import("./connect-ui.js")> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await import("./connect-ui.js");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}
