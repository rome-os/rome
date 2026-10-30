import type { LocaleBundle } from "../namespaces";
import enActivity from "../locales/en/activity.json";
import enApps from "../locales/en/apps.json";
import enAuth from "../locales/en/auth.json";
import enChat from "../locales/en/chat.json";
import enCommon from "../locales/en/common.json";
import enEnvoys from "../locales/en/envoys.json";
import enFiles from "../locales/en/files.json";
import enInbox from "../locales/en/inbox.json";
import enOnboard from "../locales/en/onboard.json";
import enPeople from "../locales/en/people.json";
import enRoutines from "../locales/en/routines.json";
import enSettings from "../locales/en/settings.json";

// One chunk per language: `bundle-loader.ts` imports this module on demand.
export default {
  common: enCommon,
  settings: enSettings,
  auth: enAuth,
  activity: enActivity,
  routines: enRoutines,
  chat: enChat,
  envoys: enEnvoys,
  people: enPeople,
  apps: enApps,
  files: enFiles,
  inbox: enInbox,
  onboard: enOnboard,
} satisfies LocaleBundle;
