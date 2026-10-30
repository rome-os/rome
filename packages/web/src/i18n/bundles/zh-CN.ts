import type { LocaleBundle } from "../namespaces";
import zhActivity from "../locales/zh-CN/activity.json";
import zhApps from "../locales/zh-CN/apps.json";
import zhAuth from "../locales/zh-CN/auth.json";
import zhChat from "../locales/zh-CN/chat.json";
import zhCommon from "../locales/zh-CN/common.json";
import zhEnvoys from "../locales/zh-CN/envoys.json";
import zhFiles from "../locales/zh-CN/files.json";
import zhInbox from "../locales/zh-CN/inbox.json";
import zhOnboard from "../locales/zh-CN/onboard.json";
import zhPeople from "../locales/zh-CN/people.json";
import zhRoutines from "../locales/zh-CN/routines.json";
import zhSettings from "../locales/zh-CN/settings.json";

// One chunk per language: `bundle-loader.ts` imports this module on demand.
export default {
  common: zhCommon,
  settings: zhSettings,
  auth: zhAuth,
  activity: zhActivity,
  routines: zhRoutines,
  chat: zhChat,
  envoys: zhEnvoys,
  people: zhPeople,
  apps: zhApps,
  files: zhFiles,
  inbox: zhInbox,
  onboard: zhOnboard,
} satisfies LocaleBundle;
