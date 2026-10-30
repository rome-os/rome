// The Rome Cloud origin this desktop build signs in to, lists instances from,
// and connects this computer through. Overridable for staging/dev; production
// builds use the default.
const ROME_CLOUD_PRODUCTION_ORIGIN = "https://romeos.cc";

export const ROME_CLOUD_ORIGIN =
  process.env.ROME_DESKTOP_PANTHEON_ORIGIN?.trim() || ROME_CLOUD_PRODUCTION_ORIGIN;
