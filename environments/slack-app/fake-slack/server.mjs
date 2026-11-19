// A stand-in for Slack, so the official Slack app can be tested with no
// person and no real workspace. It plays Slack's approve screen, the Web API
// methods the app calls, and Slack's event delivery, and it records every API
// call it receives. A control API under /_control lets a test act as a
// workspace member and read back what the bot posted.
//
// Dependency-free on purpose: it runs on a stock Node 22+ image.
// Usage and the control API are in ../README.md.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const env = process.env;

export function loadConfig(overrides = {}) {
  const workspacesFile = overrides.workspacesFile ?? env.FAKE_SLACK_WORKSPACES;
  const workspaces = workspacesFile
    ? JSON.parse(readFileSync(workspacesFile, "utf8")).workspaces
    : (overrides.workspaces ?? []);
  return {
    port: Number(overrides.port ?? env.FAKE_SLACK_PORT ?? 8080),
    tlsPort: Number(overrides.tlsPort ?? env.FAKE_SLACK_TLS_PORT ?? 0),
    tlsCert: overrides.tlsCert ?? env.FAKE_SLACK_TLS_CERT,
    tlsKey: overrides.tlsKey ?? env.FAKE_SLACK_TLS_KEY,
    appId: overrides.appId ?? env.SLACK_APP_ID ?? "A0FAKEAPP01",
    clientId: overrides.clientId ?? env.SLACK_CLIENT_ID ?? "1111111111.2222222222",
    clientSecret: overrides.clientSecret ?? env.SLACK_CLIENT_SECRET,
    signingSecret: overrides.signingSecret ?? env.SLACK_SIGNING_SECRET,
    eventsUrl: overrides.eventsUrl ?? env.FAKE_SLACK_EVENTS_URL ?? "",
    // Slack retries a failed delivery after about 0 s, 1 min and 5 min. The
    // environment shortens these (DIFFERENCES.md).
    retryDelaysMs: (overrides.retryDelaysMs ?? env.FAKE_SLACK_RETRY_DELAYS_MS ?? "1000,5000,15000")
      .toString()
      .split(",")
      .filter(Boolean)
      .map(Number),
    deliveryTimeoutMs: Number(
      overrides.deliveryTimeoutMs ?? env.FAKE_SLACK_DELIVERY_TIMEOUT_MS ?? 3000,
    ),
    stateFile: overrides.stateFile ?? env.FAKE_SLACK_STATE_FILE,
    // Slack's limit on conversations.history and conversations.replies for an
    // app outside the Marketplace: 1 request a minute per method and
    // workspace, at most 15 messages a request. On unless switched off.
    historyLimit: !/^(0|false|off)$/i.test(
      String(overrides.historyLimit ?? env.FAKE_SLACK_HISTORY_LIMIT ?? "on"),
    ),
    // Whether the app hears of its own posts in a direct message, as on Slack.
    selfEvents: !/^(0|false|off)$/i.test(
      String(overrides.selfEvents ?? env.FAKE_SLACK_SELF_EVENTS ?? "on"),
    ),
    // Whether the app's public distribution is active. Off, only its home
    // workspace (the one the app was created in) can install it.
    distributed: !/^(0|false|off)$/i.test(
      String(overrides.distributed ?? env.FAKE_SLACK_DISTRIBUTED ?? "on"),
    ),
    homeTeam: overrides.homeTeam ?? env.FAKE_SLACK_HOME_TEAM ?? workspaces[0]?.id,
    // The host a Socket Mode URL names. Inside the network it is the fake.
    socketHost: overrides.socketHost ?? env.FAKE_SLACK_SOCKET_HOST ?? "wss-primary.slack.com",
    historyWindowMs: Number(
      overrides.historyWindowMs ?? env.FAKE_SLACK_HISTORY_WINDOW_MS ?? 60_000,
    ),
    workspaces,
  };
}

// ---------------------------------------------------------------------------
// Signing, as Slack does it: v0= HMAC SHA256 over "v0:{timestamp}:{body}".
// ---------------------------------------------------------------------------

export function slackSignature(secret, timestamp, body) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    seq: 0,
    tsCounter: 0,
    installs: {}, // teamId -> { teamId, botUserId, botId, botToken, userTokens: {userId: token}, installedBy, installedAt, active }
    tokens: {}, // token -> { teamId, kind: "bot"|"user", userId, revoked }
    codes: {}, // code -> { teamId, userId, scopes, userScopes, redirectUri, expiresAt, used }
    calls: [], // { seq, at, method, teamId, tokenKind, args, ok, error }
    posts: [], // { seq, at, teamId, channel, ts, threadTs, text, blocks, user }
    events: [], // { seq, at, teamId, eventId, type, signature, body }
    deliveries: [], // { seq, at, eventId, attempt, status, error, ms }
    defaultSignIn: null, // { teamId, userId } preselected on the approve screen
    history: {}, // "teamId/channel" -> messages as Slack holds them, oldest first
    approvals: [], // { seq, at, teamId, userId, outcome: approved|cancelled|refused, error }
    // Other Slack apps installed in a workspace, as an upgrade finds them: a
    // guardian's own Socket Mode bot app (slack_bot) or Rome Cloud's earlier
    // OAuth app (slack). appId -> { appId, teamId, kind, name, botUserId, botId, ... }
    otherApps: {},
    sockets: [], // { seq, at, appId, event: opened|hello|closed|sent|acked, detail }
  };
}

export class FakeSlack {
  constructor(config) {
    this.config = config;
    if (!config.signingSecret) throw new Error("SLACK_SIGNING_SECRET is required");
    if (!config.clientSecret) throw new Error("SLACK_CLIENT_SECRET is required");
    this.workspaces = new Map(config.workspaces.map((w) => [w.id, w]));
    this.state = emptyState();
    if (config.stateFile && existsSync(config.stateFile)) {
      this.state = { ...emptyState(), ...JSON.parse(readFileSync(config.stateFile, "utf8")) };
    }
    this.seedHistory();
    this.saveTimer = null;
    this.socketTickets = new Map(); // ticket -> appId, one use each
    this.openSockets = new Set();
    this.rateLimited = new Map(); // "teamId method" -> time of the last call let through
  }

  save() {
    if (!this.config.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const tmp = `${this.config.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.config.stateFile);
    }, 50);
  }

  nextSeq() {
    this.state.seq += 1;
    this.save();
    return this.state.seq;
  }

  nextTs() {
    this.state.tsCounter = (this.state.tsCounter + 1) % 1_000_000;
    const seconds = Math.floor(Date.now() / 1000);
    return `${seconds}.${String(this.state.tsCounter).padStart(6, "0")}`;
  }

  workspace(teamId) {
    const w = this.workspaces.get(teamId);
    if (!w) throw httpError(404, `unknown workspace ${teamId}`);
    return w;
  }

  member(teamId, userId) {
    const m = this.workspace(teamId).members.find((x) => x.id === userId);
    if (!m) throw httpError(404, `unknown member ${userId} in ${teamId}`);
    return m;
  }

  /** The bot user and bot ids are fixed per workspace, as Slack keeps them across reinstalls. */
  botIds(teamId) {
    const suffix = teamId.replace(/^T/, "");
    return { botUserId: `UBOT${suffix}`, botId: `BBOT${suffix}` };
  }

  /** A direct message's conversation id is stable per (workspace, member). */
  imChannel(teamId, userId) {
    return `D${teamId.replace(/^T/, "").slice(0, 4)}${userId.replace(/^U/, "")}`;
  }

  imOwner(teamId, channel) {
    return this.workspace(teamId).members.find((m) => this.imChannel(teamId, m.id) === channel);
  }

  group(teamId, channel) {
    return (this.workspace(teamId).channels ?? []).find(
      (c) => c.id === channel || c.name === channel,
    );
  }

  activeInstall(teamId) {
    const install = this.state.installs[teamId];
    return install?.active ? install : null;
  }

  // ---------------------------------------------------------------- OAuth

  issueCode({ teamId, userId, scopes, userScopes, redirectUri }) {
    const code = `${teamId}.${randomBytes(16).toString("hex")}`;
    this.state.codes[code] = {
      teamId,
      userId,
      scopes,
      userScopes,
      redirectUri,
      expiresAt: Date.now() + 10 * 60_000,
      used: false,
    };
    this.save();
    return code;
  }

  exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    if (clientId !== this.config.clientId) return { ok: false, error: "invalid_client_id" };
    if (clientSecret !== this.config.clientSecret) return { ok: false, error: "bad_client_secret" };
    const grant = this.state.codes[code];
    if (!grant || grant.used || grant.expiresAt < Date.now())
      return { ok: false, error: "invalid_code" };
    if (redirectUri && grant.redirectUri && redirectUri !== grant.redirectUri) {
      return { ok: false, error: "bad_redirect_uri" };
    }
    grant.used = true;
    const { teamId, userId } = grant;
    const w = this.workspace(teamId);
    const { botUserId, botId } = this.botIds(teamId);
    let install = this.state.installs[teamId];
    // A new sign-in after the app was removed or its token revoked gets a new
    // token; one over a working install keeps the token, as Slack does.
    if (!install || !install.active || this.state.tokens[install.botToken]?.revoked) {
      const botToken = `xoxb-${teamId}-${randomBytes(12).toString("hex")}`;
      install = {
        teamId,
        botUserId,
        botId,
        botToken,
        userTokens: {},
        installedBy: userId,
        installedAt: new Date().toISOString(),
        active: true,
        scopes: [],
      };
      this.state.installs[teamId] = install;
      this.state.tokens[botToken] = { teamId, kind: "bot", userId: botUserId, revoked: false };
    }
    // A sign-in adds the scopes it asked for to the install's, as Slack does.
    install.scopes = [...new Set([...(install.scopes ?? []), ...splitScopes(grant.scopes)])];
    const response = {
      ok: true,
      app_id: this.config.appId,
      authed_user: { id: userId },
      scope: grant.scopes,
      token_type: "bot",
      access_token: install.botToken,
      bot_user_id: botUserId,
      team: { id: teamId, name: w.name },
      enterprise: null,
      is_enterprise_install: false,
    };
    if (grant.userScopes) {
      const userToken = `xoxp-${teamId}-${randomBytes(12).toString("hex")}`;
      install.userTokens[userId] = userToken;
      this.state.tokens[userToken] = {
        teamId,
        kind: "user",
        userId,
        revoked: false,
        scopes: splitScopes(grant.userScopes),
      };
      response.authed_user = {
        id: userId,
        scope: grant.userScopes,
        access_token: userToken,
        token_type: "user",
      };
    }
    this.save();
    return response;
  }

  // ---------------------------------------------------------------- Web API

  callApi(method, args, token) {
    const tokenInfo = token ? this.state.tokens[token] : undefined;
    const record = {
      seq: this.nextSeq(),
      at: new Date().toISOString(),
      method,
      teamId: tokenInfo?.teamId ?? null,
      tokenKind: tokenInfo?.kind ?? (token ? "unknown" : "none"),
      // The scopes the token held when it made the call.
      scopes: tokenInfo ? granted(this, tokenInfo) : [],
      args: redact(args),
    };
    const limited = this.rateLimit(method, tokenInfo);
    const result = limited ?? this.dispatch(method, args, token, tokenInfo);
    record.ok = result.ok;
    if (!result.ok) record.error = result.error;
    if (result.needed) record.needed = result.needed;
    if (limited) record.retryAfter = limited.retryAfter;
    this.state.calls.push(record);
    this.save();
    return result;
  }

  /**
   * Slack's limit for an app outside the Marketplace on the history methods:
   * the first call in a window goes through, later ones get 429 with
   * Retry-After. Returns the refusal, or null to let the call through.
   */
  rateLimit(method, tokenInfo) {
    if (!this.config.historyLimit || !HISTORY_METHODS.has(method)) return null;
    if (!tokenInfo || tokenInfo.revoked) return null;
    const key = `${tokenInfo.teamId} ${method}`;
    const now = Date.now();
    const last = this.rateLimited.get(key);
    if (last !== undefined && now - last < this.config.historyWindowMs) {
      const retryAfter = Math.max(1, Math.ceil((last + this.config.historyWindowMs - now) / 1000));
      return { ok: false, error: "ratelimited", httpStatus: 429, retryAfter };
    }
    this.rateLimited.set(key, now);
    return null;
  }

  /** Keeps a message in a conversation's history, as Slack holds what was said. */
  remember(teamId, channel, message) {
    const key = `${teamId}/${channel}`;
    const list = (this.state.history[key] ??= []);
    // An event's own type (app_mention) is not a message's type in history.
    const kept = { ...message, type: "message" };
    if (kept.thread_ts && kept.thread_ts !== kept.ts) {
      const parent = list.find((m) => m.ts === kept.thread_ts);
      if (parent) {
        parent.thread_ts = parent.ts;
        parent.reply_count = (parent.reply_count ?? 0) + 1;
        parent.reply_users = [...new Set([...(parent.reply_users ?? []), kept.user])];
        parent.reply_users_count = parent.reply_users.length;
        parent.latest_reply = kept.ts;
      }
    }
    list.push(kept);
    this.save();
    return kept;
  }

  /** Puts each group's `seed_messages` from the workspaces file in its
   *  history, once: what was said there before the app arrived. */
  seedHistory() {
    for (const w of this.workspaces.values()) {
      for (const c of w.channels ?? []) {
        for (const m of c.seed_messages ?? []) {
          const list = (this.state.history[`${w.id}/${c.id}`] ??= []);
          if (list.some((x) => x.ts === m.ts)) continue;
          list.push({ type: "message", user: m.user, text: m.text, ts: m.ts, team: w.id });
          list.sort((x, y) => Number(x.ts) - Number(y.ts));
        }
      }
    }
  }

  /** Whether the bot is in a group. A direct message with the bot always has it. */
  botInConversation(teamId, channel) {
    if (channel.startsWith("D")) return true;
    return this.group(teamId, channel)?.bot_member !== false;
  }

  /** Whether a member is in a conversation: a direct message is its own
   *  member's, a public group open to every member of the workspace. */
  userInConversation(teamId, userId, channel) {
    if (channel.startsWith("D")) return this.imOwner(teamId, channel)?.id === userId;
    const group = this.group(teamId, channel);
    if (!group) return false;
    if (!group.is_private && !group.id.startsWith("G")) return true;
    return (group.members ?? this.workspace(teamId).members.map((m) => m.id)).includes(userId);
  }

  /** Slack's refusal when a token acts where it cannot: a bot token in a
   *  group the bot is not in, a user token in a private conversation its
   *  member is not in, which Slack answers as if it did not exist. */
  notInChannel(info, channel) {
    if (info.kind === "user") {
      return this.userInConversation(info.teamId, info.userId, channel)
        ? null
        : { ok: false, error: "channel_not_found" };
    }
    if (info.kind !== "bot" || this.botInConversation(info.teamId, channel)) return null;
    return { ok: false, error: "not_in_channel" };
  }

  historyOf(teamId, channel) {
    return this.state.history[`${teamId}/${channel}`] ?? [];
  }

  /** The conversation a Web API `channel` argument names, or null. */
  resolveConversation(teamId, channel) {
    if (!channel) return null;
    if (channel.startsWith("D")) return this.imOwner(teamId, channel) ? channel : null;
    return this.group(teamId, channel)?.id ?? null;
  }

  /** A user as users.info shows it to `info`'s token, or null. */
  userObject(info, userId) {
    const teamId = info.teamId;
    const { botUserId, botId } = this.botIds(teamId);
    if (userId === botUserId) {
      return {
        id: botUserId,
        team_id: teamId,
        name: "rome",
        real_name: "Rome",
        is_bot: true,
        deleted: false,
        profile: { real_name: "Rome", display_name: "Rome", bot_id: botId },
      };
    }
    const other = Object.values(this.state.otherApps).find(
      (a) => a.teamId === teamId && a.botUserId === userId,
    );
    if (other) {
      return {
        id: other.botUserId,
        team_id: teamId,
        name: other.botName,
        real_name: other.name,
        is_bot: true,
        deleted: false,
        profile: { real_name: other.name, display_name: other.botName, bot_id: other.botId },
      };
    }
    const m = this.workspace(teamId).members.find((x) => x.id === userId);
    if (!m) return null;
    // Slack shows a member's email only to a token granted users:read.email.
    const seesEmail = granted(this, info).includes("users:read.email");
    return {
      id: m.id,
      team_id: teamId,
      name: m.name,
      real_name: m.real_name,
      is_admin: Boolean(m.is_admin),
      is_owner: Boolean(m.is_owner),
      is_bot: false,
      deleted: false,
      tz: m.tz ?? "UTC",
      profile: {
        real_name: m.real_name,
        display_name: m.display_name ?? m.name,
        ...(seesEmail && m.email ? { email: m.email } : {}),
        image_72: `https://fake-slack.invalid/avatars/${m.id}.png`,
      },
    };
  }

  /** The conversations `info`'s token can see: every group (the fake keeps no
   *  bot membership), and the direct messages with the bot, or for a user
   *  token the user's own. Each as {type, channel} in Slack's shape. */
  conversationsOf(info) {
    const w = this.workspace(info.teamId);
    const groups = (w.channels ?? []).map((c) => {
      const isPrivate = Boolean(c.is_private) || c.id.startsWith("G");
      const members = c.members ?? w.members.map((m) => m.id);
      return {
        type: isPrivate ? "private_channel" : "public_channel",
        channel: {
          id: c.id,
          name: c.name,
          is_channel: !isPrivate,
          is_group: isPrivate,
          is_im: false,
          is_private: isPrivate,
          is_archived: false,
          is_member: info.kind === "bot" ? c.bot_member !== false : members.includes(info.userId),
          num_members: members.length,
        },
      };
    });
    const ims = w.members
      .filter((m) => info.kind === "bot" || m.id === info.userId)
      .map((m) => ({
        type: "im",
        channel: {
          id: this.imChannel(info.teamId, m.id),
          is_im: true,
          is_private: true,
          user: info.kind === "bot" ? m.id : this.botIds(info.teamId).botUserId,
        },
      }));
    return [...groups, ...ims];
  }

  /** The scope a history read of `channel` needs: a direct message, a public
   *  group, or a private group (an id starting with G, or `is_private`). */
  historyScope(teamId, channel) {
    if (channel.startsWith("D")) return "im:history";
    const group = this.group(teamId, channel);
    return group?.is_private || channel.startsWith("G") ? "groups:history" : "channels:history";
  }

  dispatch(method, args, token, tokenInfo) {
    if (method === "oauth.v2.access") {
      return this.exchangeCode({
        clientId: args.client_id,
        clientSecret: args.client_secret,
        code: args.code,
        redirectUri: args.redirect_uri,
      });
    }
    if (method === "api.test") return { ok: true, args };
    if (!(method in API_METHODS)) return { ok: false, error: "unknown_method" };
    if (!token) return { ok: false, error: "not_authed" };
    if (!tokenInfo) return { ok: false, error: "invalid_auth" };
    if (tokenInfo.revoked) return { ok: false, error: "token_revoked" };
    // An app-level token opens Socket Mode connections and nothing else.
    if ((method === "apps.connections.open") !== (tokenInfo.kind === "app")) {
      return { ok: false, error: "not_allowed_token_type" };
    }
    if (USER_TOKEN_ONLY.has(method) && tokenInfo.kind === "bot") {
      return { ok: false, error: "not_allowed_token_type" };
    }
    const needed = METHOD_SCOPES[method];
    const denied = needed ? missingScope(this, tokenInfo, needed) : null;
    if (denied) return denied;
    return API_METHODS[method].call(this, args, token, tokenInfo);
  }

  // ---------------------------------------------------------------- Events

  envelope(teamId, event) {
    const install = this.activeInstall(teamId) ?? this.state.installs[teamId];
    const { botUserId } = this.botIds(teamId);
    return {
      token: "fake-verification-token",
      team_id: teamId,
      context_team_id: teamId,
      context_enterprise_id: null,
      api_app_id: this.config.appId,
      event: { ...event, event_ts: event.event_ts ?? event.ts ?? this.nextTs() },
      type: "event_callback",
      event_id: `Ev${randomBytes(6).toString("hex").toUpperCase()}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [
        {
          enterprise_id: null,
          team_id: teamId,
          user_id: install?.botUserId ?? botUserId,
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      is_ext_shared_channel: false,
      event_context: `4-${randomBytes(8).toString("hex")}`,
    };
  }

  /**
   * Signs and posts one event to the configured events address. `signature`
   * is "valid", or one of the forgeries a test uses for R7. Waits for the
   * first attempt; a valid event that fails is retried in the background.
   */
  /**
   * `onAccepted` runs once Slack would accept the event, before it is
   * delivered, so what it records is there when the app reacts to the event.
   */
  async sendEvent(
    teamId,
    event,
    { signature = "valid", requireInstall = true, onAccepted = null } = {},
  ) {
    if (!this.config.eventsUrl) throw httpError(409, "no events address configured");
    if (requireInstall && signature === "valid" && !this.activeInstall(teamId)) {
      throw httpError(409, `the app is not installed in ${teamId}`);
    }
    // Slack sends a message event only to an app granted the scope behind it.
    const eventScope =
      EVENT_SCOPES[event.type === "message" ? `message:${event.channel_type}` : event.type];
    const scopes = this.state.installs[teamId]?.scopes ?? [];
    if (requireInstall && signature === "valid" && eventScope && !scopes.includes(eventScope)) {
      throw httpError(
        409,
        `Slack sends no ${event.type} event: the install in ${teamId} lacks ${eventScope}`,
      );
    }
    onAccepted?.();
    const envelope = this.envelope(teamId, event);
    const body = JSON.stringify(envelope);
    this.state.events.push({
      seq: this.nextSeq(),
      at: new Date().toISOString(),
      teamId,
      eventId: envelope.event_id,
      type: event.type,
      channelType: event.channel_type ?? null,
      signature,
      body: envelope,
    });
    const first = await this.deliver(envelope.event_id, body, signature, 0);
    if (signature === "valid" && !isSuccess(first.status))
      this.scheduleRetry(envelope.event_id, body, 1);
    this.save();
    return { event_id: envelope.event_id, event: envelope.event, delivery: first };
  }

  scheduleRetry(eventId, body, attempt) {
    const delay = this.config.retryDelaysMs[attempt - 1];
    if (delay === undefined) return;
    setTimeout(async () => {
      const result = await this.deliver(eventId, body, "valid", attempt);
      if (!isSuccess(result.status)) this.scheduleRetry(eventId, body, attempt + 1);
    }, delay).unref();
  }

  async deliver(eventId, body, signature, attempt) {
    const realTs = Math.floor(Date.now() / 1000);
    const headers = {
      "content-type": "application/json",
      "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
    };
    const ts = signature === "stale_timestamp" ? realTs - 10 * 60 : realTs;
    if (signature !== "missing_signature") {
      headers["x-slack-request-timestamp"] = String(ts);
      const secret =
        signature === "bad_signature"
          ? `${this.config.signingSecret}-forged`
          : this.config.signingSecret;
      headers["x-slack-signature"] = slackSignature(secret, ts, body);
    }
    if (attempt > 0) {
      headers["x-slack-retry-num"] = String(attempt);
      headers["x-slack-retry-reason"] = "http_error";
    }
    const started = Date.now();
    const record = { seq: 0, at: new Date().toISOString(), eventId, attempt, signature };
    try {
      const response = await fetch(this.config.eventsUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.deliveryTimeoutMs),
      });
      record.status = response.status;
      record.responseBody = (await response.text()).slice(0, 500);
    } catch (error) {
      record.status = 0;
      record.error =
        error?.name === "TimeoutError"
          ? "http_timeout"
          : String(error?.cause?.code ?? error?.message ?? error);
    }
    record.ms = Date.now() - started;
    record.seq = this.nextSeq();
    this.state.deliveries.push(record);
    this.save();
    return record;
  }

  /** A member's direct message to the bot, as Slack's message.im event. */
  directMessage(teamId, userId, text, threadTs) {
    this.member(teamId, userId);
    const ts = this.nextTs();
    return {
      type: "message",
      channel: this.imChannel(teamId, userId),
      user: userId,
      text,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      team: teamId,
      client_msg_id: randomUUID(),
      channel_type: "im",
      blocks: richText(text),
    };
  }

  /** A member's mention of the bot in a group, as Slack's app_mention event. */
  mention(teamId, userId, channel, text, threadTs) {
    this.member(teamId, userId);
    const group = this.group(teamId, channel ?? "general");
    if (!group) throw httpError(404, `unknown group ${channel} in ${teamId}`);
    const { botUserId } = this.botIds(teamId);
    const ts = this.nextTs();
    const full = `<@${botUserId}> ${text}`;
    return {
      type: "app_mention",
      channel: group.id,
      user: userId,
      text: full,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      team: teamId,
      client_msg_id: randomUUID(),
      blocks: richText(full),
    };
  }

  /** A member's message in a group that does not mention the bot. */
  groupMessage(teamId, userId, channel, text, threadTs) {
    this.member(teamId, userId);
    const group = this.group(teamId, channel ?? "general");
    if (!group) throw httpError(404, `unknown group ${channel} in ${teamId}`);
    return {
      type: "message",
      channel: group.id,
      user: userId,
      text,
      ts: this.nextTs(),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      team: teamId,
      client_msg_id: randomUUID(),
      channel_type: "channel",
      blocks: richText(text),
    };
  }

  /** What a message event's message looks like in the conversation's history. */
  /**
   * Installs another Slack app in a workspace, as a workspace that used Rome
   * before the official app would hold one: `socket_bot`, a guardian's own app
   * on Socket Mode with a bot token and an app-level token (slack_bot), or
   * `oauth`, Rome Cloud's earlier OAuth app with a bot and a user token
   * (slack). The same name in the same workspace answers the same app.
   */
  addOtherApp({ team, kind, name, scopes, userScopes, installedBy }) {
    const w = this.workspace(team);
    if (kind !== "socket_bot" && kind !== "oauth") {
      throw httpError(400, "kind must be socket_bot or oauth");
    }
    const label = name || (kind === "socket_bot" ? "Rome Bot" : "Rome (OAuth)");
    const found = Object.values(this.state.otherApps).find(
      (a) => a.teamId === team && a.name === label,
    );
    if (found) return found;
    const n = Object.keys(this.state.otherApps).length + 1;
    const tag = `${kind === "socket_bot" ? "S" : "O"}${String(n).padStart(2, "0")}`;
    const suffix = team.replace(/^T/, "").slice(0, 4);
    const app = {
      appId: `A0OTHER${tag}${suffix}`,
      teamId: team,
      kind,
      name: label,
      botName: slackHandle(label),
      botUserId: `UOTHER${tag}${suffix}`,
      botId: `BOTHER${tag}${suffix}`,
      scopes: splitScopes(
        scopes ??
          (kind === "socket_bot"
            ? "app_mentions:read,channels:history,chat:write,groups:history,im:history,im:read,im:write,users:read"
            : "channels:read,chat:write,groups:read,im:read,mpim:read,users:read"),
      ),
      userScopes: splitScopes(userScopes ?? (kind === "oauth" ? "search:read" : "")),
      installedBy: installedBy ?? w.members.find((m) => m.is_owner)?.id ?? w.members[0].id,
      installedAt: new Date().toISOString(),
    };
    app.botToken = `xoxb-${team}-${randomBytes(12).toString("hex")}`;
    this.state.tokens[app.botToken] = {
      teamId: team,
      kind: "bot",
      userId: app.botUserId,
      botId: app.botId,
      botName: app.botName,
      appId: app.appId,
      scopes: app.scopes,
      revoked: false,
    };
    if (kind === "socket_bot") {
      app.appToken = `xapp-1-${app.appId}-${randomBytes(12).toString("hex")}`;
      this.state.tokens[app.appToken] = {
        teamId: team,
        kind: "app",
        appId: app.appId,
        scopes: ["connections:write"],
        revoked: false,
      };
    }
    if (app.userScopes.length) {
      app.userToken = `xoxp-${team}-${randomBytes(12).toString("hex")}`;
      this.state.tokens[app.userToken] = {
        teamId: team,
        kind: "user",
        userId: app.installedBy,
        appId: app.appId,
        scopes: app.userScopes,
        revoked: false,
      };
    }
    this.state.otherApps[app.appId] = app;
    this.save();
    return app;
  }

  recordSocket(appId, event, detail = null) {
    this.state.sockets.push({
      seq: this.nextSeq(),
      at: new Date().toISOString(),
      appId,
      event,
      detail,
    });
    this.save();
  }

  /**
   * Sends an Events API payload to an app over its open Socket Mode
   * connection, as Slack does for a Socket Mode app, and waits for the ack.
   */
  async sendSocketEvent(appId, event) {
    const app = this.state.otherApps[appId];
    if (!app) throw httpError(404, `no app ${appId}`);
    const open = [...this.openSockets].filter((x) => x.appId === appId);
    if (!open.length) throw httpError(409, `${appId} has no open Socket Mode connection`);
    const envelopeId = randomUUID();
    const payload = {
      ...this.envelope(app.teamId, event),
      api_app_id: appId,
      authorizations: [
        { enterprise_id: null, team_id: app.teamId, user_id: app.botUserId, is_bot: true },
      ],
    };
    const frame = {
      envelope_id: envelopeId,
      payload,
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
    };
    const socket = open.at(-1);
    const acked = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.config.deliveryTimeoutMs);
      socket.waiting.set(envelopeId, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    socket.send(JSON.stringify(frame));
    this.recordSocket(appId, "sent", { envelope_id: envelopeId, type: event.type });
    return { envelope_id: envelopeId, acked: await acked, payload };
  }

  /** Records who answered the approve screen, from which workspace, and how. */
  recordApproval(teamId, userId, outcome, error = null) {
    this.state.approvals.push({
      seq: this.nextSeq(),
      at: new Date().toISOString(),
      teamId,
      userId,
      outcome,
      error,
    });
    this.save();
  }

  rememberEvent(teamId, event) {
    const { channel, channel_type: _type, event_ts: _eventTs, ...message } = event;
    return this.remember(teamId, channel, message);
  }

  /** auth.test with the newest bot token issued in `teamId`, as Slack would answer it. */
  authTestFor(teamId) {
    this.workspace(teamId);
    const install = this.state.installs[teamId];
    if (!install) throw httpError(409, `the app was never installed in ${teamId}`);
    const info = this.state.tokens[install.botToken];
    return {
      token_state: info?.revoked ? "revoked" : "active",
      auth_test: this.dispatch("auth.test", {}, install.botToken, info),
    };
  }

  async uninstall(teamId) {
    const install = this.activeInstall(teamId);
    if (!install) throw httpError(409, `the app is not installed in ${teamId}`);
    const revokedUsers = Object.keys(install.userTokens);
    // The tokens stop working first: Slack sends tokens_revoked once tokens
    // "are revoked", and an app "is not uninstalled until its final user and bot
    // tokens are revoked". So an app that checks its token on either event
    // finds it dead.
    install.active = false;
    // Every token Rome's app was ever issued in the workspace, older user
    // tokens of a repeated sign-in too. Other apps' tokens stay.
    for (const info of Object.values(this.state.tokens)) {
      if (info.teamId === teamId && !info.appId) info.revoked = true;
    }
    this.save();
    const tokensRevoked = await this.sendEvent(
      teamId,
      { type: "tokens_revoked", tokens: { oauth: revokedUsers, bot: [install.botUserId] } },
      { requireInstall: false },
    );
    const uninstalled = await this.sendEvent(
      teamId,
      { type: "app_uninstalled" },
      { requireInstall: false },
    );
    return { tokens_revoked: tokensRevoked, app_uninstalled: uninstalled };
  }

  // ---------------------------------------------------------------- Reads

  since(list, query) {
    const after = Number(query.get("since") ?? 0);
    return list.filter((x) => x.seq > after);
  }

  posts(query) {
    return this.since(this.state.posts, query).filter(
      (p) =>
        (!query.get("team") || p.teamId === query.get("team")) &&
        (!query.get("channel") || p.channel === query.get("channel")) &&
        (!query.get("thread_ts") || p.threadTs === query.get("thread_ts")),
    );
  }

  calls(query) {
    return this.since(this.state.calls, query).filter(
      (c) =>
        (!query.get("team") || c.teamId === query.get("team")) &&
        (!query.get("method") || c.method === query.get("method")),
    );
  }

  publicState() {
    return {
      app: {
        app_id: this.config.appId,
        client_id: this.config.clientId,
        events_url: this.config.eventsUrl,
      },
      seq: this.state.seq,
      workspaces: [...this.workspaces.values()].map((w) => {
        const install = this.state.installs[w.id];
        return {
          id: w.id,
          name: w.name,
          domain: w.domain,
          bot: this.botIds(w.id),
          installed: Boolean(install?.active),
          installed_by: install?.installedBy ?? null,
          // Whether the newest bot token still works; the token itself stays out.
          token: install
            ? this.state.tokens[install.botToken]?.revoked
              ? "revoked"
              : "active"
            : null,
          // The last 6 characters of the newest bot token, to tell which
          // token a copy holds without showing it.
          bot_token_tail: install ? install.botToken.slice(-6) : null,
          scopes: install?.scopes ?? [],
          members: w.members.map((m) => ({ ...m, im_channel: this.imChannel(w.id, m.id) })),
          groups: (w.channels ?? []).map((c) => ({
            ...c,
            members: c.members ?? w.members.map((m) => m.id),
          })),
        };
      }),
      default_sign_in: this.state.defaultSignIn,
      distribution: { on: this.config.distributed, home_team: this.config.homeTeam },
      other_apps: Object.values(this.state.otherApps).map(publicOtherApp),
      open_sockets: [...this.openSockets].map((x) => ({ app_id: x.appId, since: x.since })),
      approvals: this.state.approvals,
      history_limit: {
        on: this.config.historyLimit,
        window_ms: this.config.historyWindowMs,
        max_messages: HISTORY_LIMITED_MAX,
      },
    };
  }
}

const API_METHODS = {
  "auth.test"(_args, _token, info) {
    const w = this.workspace(info.teamId);
    const install = this.state.installs[info.teamId];
    const isBot = info.kind === "bot";
    return {
      ok: true,
      url: `https://${w.domain}.slack.com/`,
      team: w.name,
      user: isBot ? (info.botName ?? "rome") : this.member(info.teamId, info.userId).name,
      team_id: info.teamId,
      user_id: info.userId,
      ...(isBot ? { bot_id: info.botId ?? install.botId } : {}),
      is_enterprise_install: false,
    };
  },

  "apps.connections.open"(_args, _token, info) {
    const app = this.state.otherApps[info.appId];
    if (!app || app.kind !== "socket_bot") return { ok: false, error: "invalid_auth" };
    const ticket = randomUUID();
    this.socketTickets.set(ticket, app.appId);
    return {
      ok: true,
      url: `wss://${this.config.socketHost}/link/?ticket=${ticket}&app_id=${app.appId}`,
    };
  },

  "auth.revoke"(args, token) {
    if (args.test === "true" || args.test === true) return { ok: true, revoked: false };
    this.state.tokens[token].revoked = true;
    return { ok: true, revoked: true };
  },

  "chat.postMessage"(args, _token, info) {
    if (!args.channel) return { ok: false, error: "channel_not_found" };
    if (!args.text && !args.markdown_text && !args.blocks && !args.attachments) {
      return { ok: false, error: "no_text" };
    }
    let channel = args.channel;
    if (channel.startsWith("U") || channel.startsWith("W")) {
      if (!this.workspace(info.teamId).members.some((m) => m.id === channel)) {
        return { ok: false, error: "channel_not_found" };
      }
      channel = this.imChannel(info.teamId, channel);
    } else if (channel.startsWith("D")) {
      if (!this.imOwner(info.teamId, channel)) return { ok: false, error: "channel_not_found" };
    } else if (!this.group(info.teamId, channel)) {
      return { ok: false, error: "channel_not_found" };
    } else {
      const group = this.group(info.teamId, channel);
      channel = group.id;
      // A bot posts where it is not a member only to a public group, and
      // only with chat:write.public.
      const isPublic = !group.is_private && !group.id.startsWith("G");
      if (
        this.notInChannel(info, channel) &&
        !(isPublic && granted(this, info).includes("chat:write.public"))
      ) {
        return { ok: false, error: "not_in_channel" };
      }
    }
    const install = this.state.installs[info.teamId];
    const ts = this.nextTs();
    const blocks = typeof args.blocks === "string" ? safeJson(args.blocks) : args.blocks;
    const post = {
      seq: this.nextSeq(),
      at: new Date().toISOString(),
      teamId: info.teamId,
      channel,
      ts,
      threadTs: args.thread_ts ?? null,
      // Slack takes `markdown_text` in place of `text`; the record keeps both.
      text: args.text ?? args.markdown_text ?? "",
      markdownText: args.markdown_text ?? null,
      blocks: blocks ?? null,
      user: info.userId,
      tokenKind: info.kind,
      // Which app posted: Rome's, or another installed in the workspace.
      appId: info.appId ?? this.config.appId,
    };
    this.state.posts.push(post);
    const said = this.remember(info.teamId, channel, {
      user: info.userId,
      ...(info.kind === "bot"
        ? { bot_id: info.botId ?? install.botId, app_id: info.appId ?? this.config.appId }
        : {}),
      text: post.text,
      ts,
      ...(post.threadTs ? { thread_ts: post.threadTs } : {}),
      team: info.teamId,
      ...(blocks ? { blocks } : {}),
    });
    // Slack tells an app subscribed to message.im of its own posts in a
    // direct message too, after it answered the call; an app must ignore them.
    if (info.kind === "bot" && !info.appId && channel.startsWith("D") && this.config.selfEvents) {
      const { type: _type, ...message } = said;
      const event = {
        type: "message",
        ...message,
        channel,
        channel_type: "im",
        bot_profile: {
          id: install.botId,
          app_id: this.config.appId,
          name: "rome",
          team_id: info.teamId,
        },
      };
      setImmediate(() => {
        this.sendEvent(info.teamId, event).catch(() => {
          // Not installed any more, or without im:history: Slack sends nothing.
        });
      });
    }
    return {
      ok: true,
      channel,
      ts,
      message: {
        type: "message",
        user: info.userId,
        ...(info.kind === "bot"
          ? { bot_id: info.botId ?? install.botId, app_id: info.appId ?? this.config.appId }
          : {}),
        text: post.text,
        ts,
        ...(post.threadTs ? { thread_ts: post.threadTs } : {}),
        team: info.teamId,
      },
    };
  },

  "conversations.history"(args, _token, info) {
    const channel = this.resolveConversation(info.teamId, args.channel);
    if (!channel) return { ok: false, error: "channel_not_found" };
    const denied = missingScope(this, info, this.historyScope(info.teamId, channel));
    if (denied) return denied;
    const outside = this.notInChannel(info, channel);
    if (outside) return outside;
    const window = timeWindow(args);
    const top = this.historyOf(info.teamId, channel)
      .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
      .filter(window)
      .reverse(); // newest first, as Slack answers
    return page(this, top, args);
  },

  "conversations.replies"(args, _token, info) {
    const channel = this.resolveConversation(info.teamId, args.channel);
    if (!channel) return { ok: false, error: "channel_not_found" };
    const denied = missingScope(this, info, this.historyScope(info.teamId, channel));
    if (denied) return denied;
    const outside = this.notInChannel(info, channel);
    if (outside) return outside;
    if (!args.ts) return { ok: false, error: "invalid_arguments" };
    const all = this.historyOf(info.teamId, channel);
    const parent = all.find((m) => m.ts === args.ts);
    if (!parent) return { ok: false, error: "thread_not_found" };
    const root = parent.thread_ts ?? parent.ts;
    const window = timeWindow(args);
    const thread = all.filter((m) => m.ts === root || m.thread_ts === root).filter(window); // oldest first; the parent at the top when the window holds it
    return page(this, thread, args);
  },

  "conversations.open"(args, _token, info) {
    if (args.channel) {
      if (!this.imOwner(info.teamId, args.channel))
        return { ok: false, error: "channel_not_found" };
      return { ok: true, channel: { id: args.channel } };
    }
    const users = String(args.users ?? "")
      .split(",")
      .filter(Boolean);
    if (users.length !== 1)
      return { ok: false, error: users.length ? "not_supported" : "users_list_not_supplied" };
    if (!this.workspace(info.teamId).members.some((m) => m.id === users[0])) {
      return { ok: false, error: "user_not_found" };
    }
    return {
      ok: true,
      no_op: true,
      already_open: true,
      channel: { id: this.imChannel(info.teamId, users[0]) },
    };
  },

  "users.info"(args, _token, info) {
    const user = this.userObject(info, args.user);
    return user ? { ok: true, user } : { ok: false, error: "user_not_found" };
  },

  // auth.test names a bot by its bot id, and bots.info names the app.
  "bots.info"(args, _token, info) {
    const own = this.botIds(info.teamId);
    if (args.bot === own.botId) {
      return {
        ok: true,
        bot: {
          id: own.botId,
          deleted: false,
          name: "rome",
          app_id: this.config.appId,
          user_id: own.botUserId,
        },
      };
    }
    const other = Object.values(this.state.otherApps).find(
      (a) => a.teamId === info.teamId && a.botId === args.bot,
    );
    if (!other) return { ok: false, error: "bot_not_found" };
    return {
      ok: true,
      bot: {
        id: other.botId,
        deleted: false,
        name: other.botName,
        app_id: other.appId,
        user_id: other.botUserId,
      },
    };
  },

  "users.list"(args, _token, info) {
    const w = this.workspace(info.teamId);
    const ids = [this.botIds(info.teamId).botUserId, ...w.members.map((m) => m.id)];
    return listPage(
      ids.map((id) => this.userObject(info, id)),
      args,
      "members",
    );
  },

  "conversations.list"(args, _token, info) {
    const types = splitScopes(args.types || "public_channel");
    for (const type of types) {
      if (!LIST_SCOPES[type]) return { ok: false, error: "invalid_types" };
      const denied = missingScope(this, info, LIST_SCOPES[type]);
      if (denied) return denied;
    }
    const all = this.conversationsOf(info).filter((c) => types.includes(c.type));
    return listPage(
      all.map((c) => c.channel),
      args,
      "channels",
    );
  },

  "conversations.info"(args, _token, info) {
    const channel = this.resolveConversation(info.teamId, args.channel);
    if (!channel) return { ok: false, error: "channel_not_found" };
    const found = this.conversationsOf(info).find((c) => c.channel.id === channel);
    if (!found) return { ok: false, error: "channel_not_found" };
    const denied = missingScope(this, info, LIST_SCOPES[found.type]);
    if (denied) return denied;
    return { ok: true, channel: found.channel };
  },

  "reactions.add"(args, _token, info) {
    const channel = this.resolveConversation(info.teamId, args.channel);
    if (!channel) return { ok: false, error: "channel_not_found" };
    if (!args.name) return { ok: false, error: "invalid_name" };
    const outside = this.notInChannel(info, channel);
    if (outside) return outside;
    const message = this.historyOf(info.teamId, channel).find((m) => m.ts === args.timestamp);
    if (!message) return { ok: false, error: "message_not_found" };
    const name = String(args.name).replace(/^:|:$/g, "");
    message.reactions ??= [];
    let reaction = message.reactions.find((r) => r.name === name);
    if (!reaction) {
      reaction = { name, users: [], count: 0 };
      message.reactions.push(reaction);
    }
    if (reaction.users.includes(info.userId)) return { ok: false, error: "already_reacted" };
    reaction.users.push(info.userId);
    reaction.count = reaction.users.length;
    this.save();
    return { ok: true };
  },

  "search.messages"(args, _token, info) {
    if (!args.query) return { ok: false, error: "no_query" };
    const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
    const w = this.workspace(info.teamId);
    const matches = [];
    for (const c of this.conversationsOf(info)) {
      // Slack searches only what the searching user can see.
      if (c.type !== "im" && !c.channel.is_member) continue;
      for (const m of this.historyOf(info.teamId, c.channel.id)) {
        const text = String(m.text ?? "").toLowerCase();
        if (!words.every((word) => text.includes(word))) continue;
        matches.push({
          type: "message",
          channel: { id: c.channel.id, name: c.channel.name ?? c.channel.id },
          user: m.user ?? null,
          username: w.members.find((x) => x.id === m.user)?.name ?? null,
          ts: m.ts,
          text: m.text,
          permalink: `https://${w.domain}.slack.com/archives/${c.channel.id}/p${m.ts.replace(".", "")}`,
        });
      }
    }
    matches.sort((a, b) => Number(b.ts) - Number(a.ts));
    const count = Math.min(100, Math.max(1, Number(args.count) || 20));
    const pageNo = Math.max(1, Number(args.page) || 1);
    const pages = Math.max(1, Math.ceil(matches.length / count));
    return {
      ok: true,
      query: args.query,
      messages: {
        total: matches.length,
        matches: matches.slice((pageNo - 1) * count, pageNo * count),
        paging: { count, total: matches.length, page: pageNo, pages },
        pagination: {
          total_count: matches.length,
          page: pageNo,
          per_page: count,
          page_count: pages,
          first: (pageNo - 1) * count + 1,
          last: Math.min(pageNo * count, matches.length),
        },
      },
    };
  },
};

/** One page of a list method, with Slack's cursor. */
function listPage(items, args, key) {
  const asked = Number(args.limit);
  const limit = Math.min(1000, asked > 0 ? asked : 100);
  let offset = 0;
  if (args.cursor) {
    offset = Number(
      Buffer.from(String(args.cursor), "base64url")
        .toString("utf8")
        .replace(/^offset:/, ""),
    );
    if (!Number.isInteger(offset) || offset < 0) return { ok: false, error: "invalid_cursor" };
  }
  const more = offset + limit < items.length;
  return {
    ok: true,
    [key]: items.slice(offset, offset + limit),
    response_metadata: {
      next_cursor: more ? Buffer.from(`offset:${offset + limit}`).toString("base64url") : "",
    },
  };
}

const HISTORY_METHODS = new Set(["conversations.history", "conversations.replies"]);
const HISTORY_LIMITED_MAX = 15;

function splitScopes(scopes) {
  return String(scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The bot scope each Web API method needs. The history methods need one by
 *  the kind of conversation, checked in the method. */
const METHOD_SCOPES = {
  "chat.postMessage": "chat:write",
  "conversations.open": "im:write",
  "bots.info": "users:read",
  "users.info": "users:read",
  "users.list": "users:read",
  "reactions.add": "reactions:write",
  "search.messages": "search:read",
};

/** Methods Slack answers only for a user token: a bot token gets
 *  not_allowed_token_type. */
const USER_TOKEN_ONLY = new Set(["search.messages", "search.all", "search.files"]);

/** The read scope behind each conversation type of conversations.list. */
const LIST_SCOPES = {
  public_channel: "channels:read",
  private_channel: "groups:read",
  im: "im:read",
  mpim: "mpim:read",
};

/** The scopes a token holds: a bot token the install's, a user token its own. */
function granted(slack, info) {
  // Rome's app's bot token holds its install's scopes; every other token,
  // another app's bot token included, holds its own.
  return info.kind === "bot" && !info.appId
    ? (slack.state.installs[info.teamId]?.scopes ?? [])
    : (info.scopes ?? []);
}

/** The bot scope Slack needs before it sends the app an event of this kind. */
const EVENT_SCOPES = {
  app_mention: "app_mentions:read",
  "message:im": "im:history",
  "message:channel": "channels:history",
  "message:group": "groups:history",
};

/** Slack's refusal when a token lacks `needed`, or null. */
function missingScope(slack, info, needed) {
  const provided = granted(slack, info);
  if (provided.includes(needed)) return null;
  return { ok: false, error: "missing_scope", needed, provided: provided.join(",") };
}

/** Slack's `oldest`, `latest` and `inclusive` as a filter on messages. */
function timeWindow(args) {
  const inclusive = args.inclusive === true || args.inclusive === "true" || args.inclusive === "1";
  const oldest = args.oldest !== undefined && args.oldest !== "" ? Number(args.oldest) : null;
  const latest = args.latest !== undefined && args.latest !== "" ? Number(args.latest) : null;
  return (m) => {
    const ts = Number(m.ts);
    if (oldest !== null && (inclusive ? ts < oldest : ts <= oldest)) return false;
    if (latest !== null && (inclusive ? ts > latest : ts >= latest)) return false;
    return true;
  };
}

/** One page of `messages` under Slack's `limit` and `cursor`. */
function page(slack, messages, args) {
  const max = slack.config.historyLimit ? HISTORY_LIMITED_MAX : 999;
  const asked = args.limit !== undefined && args.limit !== "" ? Number(args.limit) : null;
  const limit = Math.min(max, asked && asked > 0 ? asked : slack.config.historyLimit ? 15 : 100);
  let offset = 0;
  if (args.cursor) {
    const decoded = Number(
      Buffer.from(String(args.cursor), "base64url")
        .toString("utf8")
        .replace(/^offset:/, ""),
    );
    if (!Number.isInteger(decoded) || decoded < 0) return { ok: false, error: "invalid_cursor" };
    offset = decoded;
  }
  const slice = messages.slice(offset, offset + limit).map(publicMessage);
  const hasMore = offset + limit < messages.length;
  return {
    ok: true,
    messages: slice,
    has_more: hasMore,
    pin_count: 0,
    response_metadata: {
      next_cursor: hasMore ? Buffer.from(`offset:${offset + limit}`).toString("base64url") : "",
    },
  };
}

function publicMessage(m) {
  return structuredClone(m);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function isSuccess(status) {
  return status >= 200 && status < 300;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redact(args) {
  const out = { ...args };
  for (const k of ["client_secret", "token", "code"]) if (k in out) out[k] = "[redacted]";
  return out;
}

function richText(text) {
  return [
    {
      type: "rich_text",
      block_id: randomBytes(3).toString("hex"),
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
    },
  ];
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(req, url, raw) {
  const args = Object.fromEntries(url.searchParams);
  const type = req.headers["content-type"] ?? "";
  if (raw) {
    if (type.includes("application/json")) Object.assign(args, JSON.parse(raw));
    else Object.assign(args, Object.fromEntries(new URLSearchParams(raw)));
  }
  // oauth.v2.access also takes the client credentials as HTTP Basic auth.
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
    args.client_id ??= id;
    args.client_secret ??= secret;
  }
  return args;
}

function bearer(req, args) {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return args.token;
}

function send(res, status, body, headers = {}) {
  const isString = typeof body === "string";
  res.writeHead(status, {
    "content-type": isString ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function refusedPage(slack, teamId, error) {
  const w = slack.workspaces.get(teamId);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Installation failed</title></head>
<body><main><p class="note">Fake Slack: a stand-in for slack.com used in tests.</p>
<h1>Rome can't be installed in ${escapeHtml(w?.name ?? teamId)}</h1>
<p>This app can only be installed in the workspace it was created in.</p>
<p><code id="error">${error}</code></p></main></body></html>`;
}

function approvePage(slack, params) {
  const def = slack.state.defaultSignIn;
  const teamId = params.get("team") || def?.teamId || slack.config.workspaces[0]?.id;
  const w = slack.workspaces.get(teamId) ?? slack.config.workspaces[0];
  const userId =
    params.get("user") || (def?.teamId === w.id ? def.userId : null) || w.members[0].id;
  const scopes = (params.get("scope") ?? "").split(",").filter(Boolean);
  const hidden = ["client_id", "scope", "user_scope", "redirect_uri", "state"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? "")}">`)
    .join("");
  const workspaceOptions = slack.config.workspaces
    .map(
      (x) =>
        `<option value="${x.id}"${x.id === w.id ? " selected" : ""}>${escapeHtml(x.name)}</option>`,
    )
    .join("");
  const memberOptions = w.members
    .map(
      (m) =>
        `<option value="${m.id}"${m.id === userId ? " selected" : ""}>${escapeHtml(m.real_name)}</option>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Rome is requesting permission to access the ${escapeHtml(w.name)} Slack workspace</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#f8f8f8;margin:0;padding:40px 16px}main{max-width:520px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:28px}
h1{font-size:22px}li{margin:4px 0}.row{display:flex;gap:8px;margin:12px 0}.row label{width:110px;color:#555}button{font-size:15px;padding:10px 18px;border-radius:4px;border:1px solid #bbb;background:#fff;cursor:pointer}
button[name=decision][value=allow]{background:#007a5a;color:#fff;border-color:#007a5a}.note{color:#777;font-size:12px}</style></head>
<body><main><p class="note">Fake Slack: a stand-in for slack.com used in tests.</p>
<h1>Rome is requesting permission to access the <span id="workspace-name">${escapeHtml(w.name)}</span> Slack workspace</h1>
<form method="post" action="/oauth/v2/authorize/approve">${hidden}
<div class="row"><label for="team">Workspace</label><select id="team" name="team" onchange="location.search=new URLSearchParams({...Object.fromEntries(new URLSearchParams(location.search)),team:this.value,user:''})">${workspaceOptions}</select></div>
<div class="row"><label for="user">Signed in as</label><select id="user" name="user">${memberOptions}</select></div>
<p>What will Rome be able to view and do?</p><ul>${scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}</ul>
<div class="row"><button type="submit" name="decision" value="cancel">Cancel</button><button type="submit" name="decision" value="allow" id="allow">Allow</button></div>
</form></main></body></html>`;
}

export function createHandler(slack) {
  return async function handle(req, res) {
    const url = new URL(req.url, "http://fake-slack");
    try {
      const raw = req.method === "GET" ? "" : await readBody(req);

      // ----- Approve screen
      if (url.pathname === "/oauth/v2/authorize" && req.method === "GET") {
        if (url.searchParams.get("client_id") !== slack.config.clientId) {
          return send(res, 400, "<h1>Invalid client_id parameter</h1>");
        }
        if (!url.searchParams.get("redirect_uri"))
          return send(res, 400, "<h1>Missing redirect_uri</h1>");
        return send(res, 200, approvePage(slack, url.searchParams));
      }
      if (url.pathname === "/oauth/v2/authorize/approve" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        const redirect = new URL(form.get("redirect_uri"));
        if (form.get("state")) redirect.searchParams.set("state", form.get("state"));
        const teamId = form.get("team");
        if (form.get("decision") !== "allow") {
          slack.recordApproval(teamId, form.get("user"), "cancelled");
          redirect.searchParams.set("error", "access_denied");
          return send(res, 302, "", { location: redirect.toString() });
        }
        slack.member(teamId, form.get("user"));
        // An app without public distribution installs only where it was made.
        if (!slack.config.distributed && teamId !== slack.config.homeTeam) {
          const error = "invalid_team_for_non_distributed_app";
          slack.recordApproval(teamId, form.get("user"), "refused", error);
          return send(res, 403, refusedPage(slack, teamId, error));
        }
        slack.recordApproval(teamId, form.get("user"), "approved");
        const code = slack.issueCode({
          teamId,
          userId: form.get("user"),
          scopes: form.get("scope") ?? "",
          userScopes: form.get("user_scope") ?? "",
          redirectUri: form.get("redirect_uri"),
        });
        redirect.searchParams.set("code", code);
        return send(res, 302, "", { location: redirect.toString() });
      }

      // ----- Web API
      if (url.pathname.startsWith("/api/")) {
        const method = url.pathname.slice(5);
        const args = parseArgs(req, url, raw);
        const { httpStatus, retryAfter, ...result } = slack.callApi(
          method,
          args,
          bearer(req, args),
        );
        return send(
          res,
          httpStatus ?? 200,
          result,
          retryAfter ? { "retry-after": String(retryAfter) } : {},
        );
      }

      // ----- Control API
      if (url.pathname.startsWith("/_control/")) {
        const body = raw ? JSON.parse(raw) : {};
        return send(res, 200, await control(slack, req.method, url, body));
      }

      return send(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      return send(res, error.status ?? 500, { ok: false, error: error.message });
    }
  };
}

async function control(slack, method, url, body) {
  const route = `${method} ${url.pathname.slice("/_control".length)}`;
  const q = url.searchParams;
  switch (route) {
    case "GET /health":
      return { ok: true };
    case "GET /state":
      return { ok: true, ...slack.publicState() };
    case "POST /sign-in":
      // Which workspace and member the approve screen preselects.
      slack.member(body.team, body.user);
      slack.state.defaultSignIn = { teamId: body.team, userId: body.user };
      slack.save();
      return { ok: true };
    case "POST /dm": {
      const event = slack.directMessage(body.team, body.user, body.text, body.thread_ts);
      return { ok: true, ...(await sendAndRemember(slack, body.team, event)) };
    }
    case "POST /mention": {
      const event = slack.mention(body.team, body.user, body.channel, body.text, body.thread_ts);
      return { ok: true, ...(await sendAndRemember(slack, body.team, event)) };
    }
    case "POST /group-message": {
      // A group message that does not mention the bot. The app subscribes to
      // no group message events, so Slack sends it nothing; it is only in
      // the group's history. `send_event: true` sends it as message.channels.
      const event = slack.groupMessage(
        body.team,
        body.user,
        body.channel,
        body.text,
        body.thread_ts,
      );
      if (body.send_event) return { ok: true, ...(await sendAndRemember(slack, body.team, event)) };
      slack.rememberEvent(body.team, event);
      return { ok: true, event_sent: false, event };
    }
    case "GET /history": {
      const team = q.get("team");
      const channel = slack.resolveConversation(team, q.get("channel"));
      if (!channel) throw httpError(404, `unknown conversation ${q.get("channel")} in ${team}`);
      return { ok: true, seq: slack.state.seq, channel, messages: slack.historyOf(team, channel) };
    }
    case "POST /auth-test":
      return { ok: true, ...slack.authTestFor(body.team) };
    case "POST /forged": {
      // An event Slack did not sign: bad_signature (default), stale_timestamp or missing_signature.
      const event =
        body.kind === "mention"
          ? slack.mention(body.team, body.user, body.channel, body.text)
          : slack.directMessage(body.team, body.user, body.text);
      return {
        ok: true,
        ...(await slack.sendEvent(body.team, event, {
          signature: body.mode ?? "bad_signature",
          requireInstall: false,
        })),
      };
    }
    case "POST /event":
      return {
        ok: true,
        ...(await slack.sendEvent(body.team, body.event, {
          signature: body.signature ?? "valid",
          requireInstall: body.require_install !== false,
        })),
      };
    case "POST /url-verification": {
      const challenge = randomBytes(16).toString("hex");
      const payload = JSON.stringify({
        token: "fake-verification-token",
        challenge,
        type: "url_verification",
      });
      const delivery = await slack.deliver("url_verification", payload, "valid", 0);
      return { ok: true, challenge, delivery };
    }
    case "POST /uninstall":
      return { ok: true, ...(await slack.uninstall(body.team)) };
    case "GET /posts":
      return { ok: true, seq: slack.state.seq, posts: slack.posts(q) };
    case "GET /calls":
      return { ok: true, seq: slack.state.seq, calls: slack.calls(q) };
    case "POST /other-app": {
      // Setup only: answers the tokens, so a seed can hand them to Rome.
      const app = slack.addOtherApp({
        team: body.team,
        kind: body.kind,
        name: body.name,
        scopes: body.scopes,
        userScopes: body.user_scopes,
        installedBy: body.installed_by,
      });
      return {
        ok: true,
        ...publicOtherApp(app),
        bot_token: app.botToken,
        app_token: app.appToken ?? null,
        user_token: app.userToken ?? null,
      };
    }
    case "GET /sockets":
      return { ok: true, seq: slack.state.seq, sockets: slack.since(slack.state.sockets, q) };
    case "POST /socket-event":
      return { ok: true, ...(await slack.sendSocketEvent(body.app_id, body.event)) };
    case "GET /approvals":
      return { ok: true, seq: slack.state.seq, approvals: slack.since(slack.state.approvals, q) };
    case "GET /events":
      return { ok: true, seq: slack.state.seq, events: slack.since(slack.state.events, q) };
    case "GET /deliveries":
      return {
        ok: true,
        seq: slack.state.seq,
        deliveries: slack
          .since(slack.state.deliveries, q)
          .filter((d) => !q.get("event_id") || d.eventId === q.get("event_id")),
      };
    case "POST /config":
      // Lets a test point events elsewhere or change retry timing at run time.
      if (body.events_url !== undefined) slack.config.eventsUrl = body.events_url;
      if (body.retry_delays_ms !== undefined) slack.config.retryDelaysMs = body.retry_delays_ms;
      if (body.history_limit !== undefined) {
        slack.config.historyLimit = Boolean(body.history_limit);
        slack.rateLimited.clear();
      }
      if (body.history_window_ms !== undefined)
        slack.config.historyWindowMs = body.history_window_ms;
      if (body.self_events !== undefined) slack.config.selfEvents = Boolean(body.self_events);
      if (body.distributed !== undefined) slack.config.distributed = Boolean(body.distributed);
      return {
        distributed: slack.config.distributed,
        home_team: slack.config.homeTeam,
        ok: true,
        events_url: slack.config.eventsUrl,
        retry_delays_ms: slack.config.retryDelaysMs,
        history_limit: slack.config.historyLimit,
        history_window_ms: slack.config.historyWindowMs,
        self_events: slack.config.selfEvents,
      };
    case "POST /reset": {
      // Clears the records. Keeps installs and tokens unless {"installs": true},
      // and what was said unless {"history": true}.
      const keep = body.installs ? emptyState() : { ...slack.state };
      slack.state = {
        ...emptyState(),
        installs: keep.installs,
        tokens: keep.tokens,
        otherApps: keep.otherApps ?? {},
        history: body.history ? {} : slack.state.history,
        seq: slack.state.seq,
        // Kept, so a message after a reset never takes an earlier one's ts.
        tsCounter: slack.state.tsCounter,
      };
      slack.seedHistory();
      slack.rateLimited.clear();
      slack.save();
      return { ok: true, seq: slack.state.seq };
    }
    default:
      throw httpError(404, `no control route ${route}`);
  }
}

function publicOtherApp(app) {
  return {
    app_id: app.appId,
    team_id: app.teamId,
    kind: app.kind,
    name: app.name,
    bot_user_id: app.botUserId,
    bot_id: app.botId,
    scopes: app.scopes,
    user_scopes: app.userScopes,
    installed_by: app.installedBy,
    bot_token_tail: app.botToken.slice(-6),
    user_token_tail: app.userToken ? app.userToken.slice(-6) : null,
  };
}

/** Slack's bot handle: lowercase letters, digits, `.`, `-` and `_`. */
function slackHandle(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "bot"
  );
}

/**
 * Socket Mode, as Slack serves it: a WebSocket at the URL apps.connections.open
 * answered, which says hello, sends Events API payloads, and takes an ack per
 * envelope. Only what RFC 6455 needs for text frames, ping and close.
 */
function acceptSocket(slack, req, socket) {
  const url = new URL(req.url, "http://fake-slack");
  const appId = slack.socketTickets.get(url.searchParams.get("ticket") ?? "");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/link/" || !appId || !key) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  slack.socketTickets.delete(url.searchParams.get("ticket"));
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = {
    appId,
    since: new Date().toISOString(),
    waiting: new Map(),
    send: (text) => socket.write(wsFrame(0x1, Buffer.from(text))),
  };
  slack.openSockets.add(conn);
  slack.recordSocket(appId, "opened");
  conn.send(
    JSON.stringify({
      type: "hello",
      num_connections: [...slack.openSockets].filter((x) => x.appId === appId).length,
      debug_info: { host: "fake-slack", build_number: 1, approximate_connection_time: 3600 },
      connection_info: { app_id: appId },
    }),
  );
  slack.recordSocket(appId, "hello");
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = readWsFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.length);
      if (frame.opcode === 0x8) {
        socket.end(wsFrame(0x8, Buffer.alloc(0)));
        return;
      }
      if (frame.opcode === 0x9) socket.write(wsFrame(0xa, frame.payload));
      if (frame.opcode !== 0x1) continue;
      try {
        const message = JSON.parse(frame.payload.toString("utf8"));
        const done = message.envelope_id && conn.waiting.get(message.envelope_id);
        if (done) {
          conn.waiting.delete(message.envelope_id);
          slack.recordSocket(appId, "acked", { envelope_id: message.envelope_id });
          done();
        }
      } catch {
        // Not JSON: Slack ignores it too.
      }
    }
  });
  const close = () => {
    if (!slack.openSockets.delete(conn)) return;
    slack.recordSocket(appId, "closed");
  };
  socket.on("close", close);
  socket.on("error", close);
}

function wsFrame(opcode, payload) {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
  return Buffer.concat([head, payload]);
}

function bigLength(length) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(length));
  return b;
}

/** One frame from the front of `buffer`, unmasked, or null until it is whole. */
function readWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
  return { opcode, payload, length: offset + length };
}

/** Sends a member's message event. The message enters Slack's history once
 *  Slack accepts it (the app is installed and holds the scope), before the app
 *  hears of it. */
async function sendAndRemember(slack, team, event) {
  return slack.sendEvent(team, event, { onAccepted: () => slack.rememberEvent(team, event) });
}

export function start(config = loadConfig()) {
  const slack = new FakeSlack(config);
  const handler = createHandler(slack);
  const servers = [createHttpServer(handler).listen(config.port)];
  if (config.tlsPort && config.tlsCert && config.tlsKey) {
    servers.push(
      createHttpsServer(
        { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) },
        handler,
      ).listen(config.tlsPort),
    );
  }
  for (const server of servers)
    server.on("upgrade", (req, socket) => acceptSocket(slack, req, socket));
  return { slack, servers };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  start(config);
  console.log(
    JSON.stringify({
      msg: "fake slack listening",
      port: config.port,
      tlsPort: config.tlsPort || null,
      eventsUrl: config.eventsUrl,
      workspaces: config.workspaces.map((w) => w.id),
    }),
  );
}
