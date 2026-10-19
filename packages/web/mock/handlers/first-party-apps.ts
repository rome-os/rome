// The first-party apps core installs at boot, as `GET /api/apps` lists them.
// Catalog scope: docs/dashboard-mock-mode.md.
import type { InstalledAppCard } from "@rome/api-types/apps";
// Imported from each app's tree rather than copied, so an icon change in
// rome_apps/ reaches the mock without a second edit.
import assistantIcon from "../../../../rome_apps/assistant/assets/icon.svg";
import briefingIcon from "../../../../rome_apps/briefing/src/assets/icon.svg";
import browserAutomationIcon from "../../../../rome_apps/browser-automation/assets/icon.svg";
import codingIcon from "../../../../rome_apps/coding/assets/icon.svg";
import connectorIcon from "../../../../rome_apps/connector/assets/icon.svg";
import dreamIcon from "../../../../rome_apps/dream/assets/icon.svg";
import inboxIcon from "../../../../rome_apps/inbox/assets/icon.svg";
import recapIcon from "../../../../rome_apps/recap/assets/icon.svg";
import showcasesIcon from "../../../../rome_apps/showcases/src/assets/icon.svg";
import skillsIcon from "../../../../rome_apps/skills/assets/icon.svg";
import systemIcon from "../../../../rome_apps/system/assets/icon.svg";
import welcomeToRomeIcon from "../../../../rome_apps/welcome-to-rome/src/assets/icon.svg";
import workflowStudioIcon from "../../../../rome_apps/workflow-studio/src/assets/icon.svg";

// One entry per rome_apps/<id>/ that has an app.yaml, which is the set
// `pnpm build:apps` packs into dist/first-party-artifacts/ and boot installs.
// Each field is copied from that app.yaml. `hasFrontend` mirrors whether the
// manifest declares `web:`. Core still lists an app without one (assistant),
// with no open link.
const definitions = [
  {
    id: "assistant",
    displayName: "Assistant",
    version: "0.1.6",
    description:
      'General assistance agents and routine-management guidance. Provides the routine-from-chat skill — reach for it first whenever the guardian wants something to happen automatically: it turns a plain-language "do this automatically" request into an event-triggered ("text me when I get an email from my landlord") or scheduled ("remind me every Friday at 9am") routine instead of hand-building a trigger.',
    hasFrontend: false,
    iconUrl: assistantIcon,
  },
  {
    id: "briefing",
    displayName: "Briefing",
    version: "0.3.0",
    description:
      "Scheduled morning and evening briefings that fold in your calendar, recent messages, and the findings of recurring scouting tasks run by the assistant.",
    hasFrontend: true,
    iconUrl: briefingIcon,
  },
  {
    id: "browser-automation",
    displayName: "Browser Automation",
    version: "0.2.1",
    description:
      "Operate the agent's browser to visit and act on websites via predefined automation actions/scripts exposed by the `opencli` tool. You can get the supported commands by running shell command `opencli <site_name> --help`, where site_name can be amazon, google, instagram, linkedin, producthunt, substack, twitter, wikipedia, xiaohongshu, youtube or more. To know all available commands, run `opencli list`. Also drives ChatGPT through the logged-in browser session — `chatgpt_chat` sends a prompt and returns the markdown response, and `chatgpt_image` generates a ChatGPT image and saves it to disk.",
    hasFrontend: true,
    iconUrl: browserAutomationIcon,
  },
  {
    id: "coding",
    displayName: "Coding",
    version: "0.3.2",
    description:
      "The coding agent, the app_creation skill, and a frontend gallery of live UI mocks. Use app_creation when visuals are important, such as for apps, dashboards, games, and other Rome experiences that need a polished UI.",
    hasFrontend: true,
    iconUrl: codingIcon,
  },
  {
    id: "connector",
    displayName: "Connector",
    version: "0.7.0",
    description:
      "Connect and orchestrate third-party APIs (Gmail, Calendar, Slack, Supabase, Neon, and more) via Composio. Once a toolkit is connected, call its native provider REST/GraphQL API with the `connector_proxy` action: pass the toolkit slug, a relative `path` (e.g. `/gmail/v1/users/me/messages`), and the method — Connector prepends the toolkit's API host and injects the connection's credential, so you handle neither the host nor the token. `connector_proxy` requires being signed in (`connector_login`) and the toolkit connected (`connector_connect`) first, and fails closed (not-signed-in, not-connected, or a non-2xx provider response all return an action error). Connectable toolkits (slug): Gmail (`gmail`), Outlook (`outlook`), Calendar (`googlecalendar`), GitHub (`github`), Slack (`slack`), Notion (`notion`), Drive (`googledrive`), Sheets (`googlesheets`), Docs (`googledocs`), Slides (`googleslides`), Google Ads (`googleads`), Dropbox (`dropbox`), Linear (`linear`), Discord (`discord`), LinkedIn (`linkedin`), Meta Ads (`metaads`), Supabase (`supabase`), Neon (`neon`), HubSpot (`hubspot`), Stripe (`stripe`). This is the set of toolkits that are connectable — not which are currently connected. If you need one that isn't connected yet, ask the guardian to connect it. Connection status is not known here, so if a call comes back as not-connected, ask the guardian to connect it again. Rome fills in each toolkit's API host, so pass only `path` and omit `host` — except where there is no deterministic host: supply `host` for Supabase (the per-project `<project-ref>.supabase.co`), or to reach a provider's non-default host (Dropbox content `content.dropboxapi.com`, GitHub uploads `uploads.github.com`).\n\nFor GitHub, prefer the `gh` CLI and `git` directly in the shell (`gh api`, `gh pr`, `git clone/push`) — it's Rome-managed (no Composio). If a `gh`/`git` call reports it is not authenticated, ask the guardian to connect GitHub at `/settings`. To react to GitHub events (push, PRs, issues), use `connector_github_subscribe` (NOT `connector_event_subscribe`, which is Composio-only) — it registers Rome's own webhook on the repo/org and returns the event-bus topic a routine binds to. To stop receiving them, use `connector_github_unsubscribe` with the same repo/org.\n\nSlack is also Rome-managed (no Composio): act on it with `connector_proxy` (toolkit `slack`) against the Slack Web API — e.g. POST `/api/chat.postMessage`, `/api/conversations.list`, `/api/search.messages`. Do NOT use `connector_login`/`connector_connect`/`connector_tool_execute` for Slack. If a Slack call comes back not-connected, ask the guardian to connect Slack at `/settings`.\n",
    hasFrontend: true,
    iconUrl: connectorIcon,
  },
  {
    id: "dream",
    displayName: "Dream",
    version: "0.2.0",
    description:
      "Periodic self-review agent that summarizes recent conversations and updates memory",
    hasFrontend: true,
    iconUrl: dreamIcon,
  },
  {
    id: "inbox",
    displayName: "Inbox",
    version: "0.2.13",
    description: "Incoming-message triage, routing, and channel hooks",
    hasFrontend: true,
    iconUrl: inboxIcon,
  },
  {
    id: "recap",
    displayName: "Recap",
    version: "0.1.1",
    description: "Spoken recaps for completed WebChat turns",
    hasFrontend: true,
    iconUrl: recapIcon,
  },
  {
    id: "showcases",
    displayName: "Showcases",
    version: "0.1.0",
    description: "Import, view, export, and share static Rome agent trace showcases.",
    hasFrontend: true,
    iconUrl: showcasesIcon,
  },
  {
    id: "skills",
    displayName: "Skills",
    version: "0.2.0",
    description:
      "Browse every skill installed on this Rome, start a chat that uses one (each skill is a slash command in webchat), and import or generate new skills with the import-skill skill.",
    hasFrontend: true,
    iconUrl: skillsIcon,
  },
  {
    id: "system",
    displayName: "System",
    version: "0.2.20",
    description:
      "Core system actions for scheduling, messaging, approvals, app store access, and subagent orchestration. In Rome context, 'store' / 'app store' usually means the Rome App Store. Reach here first for app_store_search (search/read Rome Store listings), app_management (install from the Rome Store with source.mode='appstore', install / uninstall / enable / disable a Rome app, or scaffold a new dev app — first-party apps ship with Rome, so only enable/disable applies to them), send_message (send a message through any registered channel adapter), send_user_message (start or continue a webchat conversation on the guardian's behalf), and generate_image (generate an image from a text prompt via the connected image provider).",
    hasFrontend: true,
    iconUrl: systemIcon,
    // Core refuses to disable the system app, unlike every other first-party app.
    canToggle: false,
  },
  {
    id: "welcome-to-rome",
    displayName: "Welcome to Rome",
    version: "0.1.0",
    description:
      "Conversational first-run onboarding. The guardian chats with Rome in the standard Chat UI; a turn-middleware state machine confirms the names, connects an AI, asks one question, and hands off to a first chat, rendering the app's own inline cards and handing the heavy steps to specialist agents.",
    hasFrontend: true,
    iconUrl: welcomeToRomeIcon,
  },
  {
    id: "workflow-studio",
    displayName: "Workflows",
    version: "0.1.0",
    description:
      "Describe an automation in plain language; approve the short spec, and it's built into a runnable workflow in one conversation.",
    hasFrontend: true,
    iconUrl: workflowStudioIcon,
  },
];

// Boot installs these before the guardian can install anything, so the
// timestamp predates every recorded App Store install.
const bootedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

export const firstPartyApps: InstalledAppCard[] = definitions.map((app) => ({
  id: app.id,
  displayName: app.displayName,
  description: app.description,
  version: app.version,
  status: "active",
  phase: "installed",
  hasFrontend: app.hasFrontend,
  href: app.hasFrontend ? `/apps/${app.id}` : null,
  fullHref: app.hasFrontend ? `/full/apps/${app.id}` : null,
  capabilities: [],
  capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
  isEnabled: true,
  canToggle: app.canToggle ?? true,
  canUninstall: false,
  // Core refuses to publish a boot-installed artifact, since it is Rome's own build.
  canPublish: false,
  accessMode: "private",
  isPublic: false,
  cloudAllowedEmails: [],
  canManagePublicAccess: app.hasFrontend,
  source: { mode: "bundle", path: `/opt/rome/dist/first-party-artifacts/${app.id}` },
  projectPath: null,
  origin: "builtin",
  iconUrl: app.iconUrl,
  installedAt: bootedAt,
}));
