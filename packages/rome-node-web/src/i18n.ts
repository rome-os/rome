import type { AuditUnavailableCode, HostPhase } from "./types";

export type Locale = "en" | "zh-CN";

const LOCALE_STORAGE_KEY = "rome-node-locale";

export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
    // Ignore storage errors.
  }
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage errors.
  }
}

export const messages = {
  en: {
    brandName: "Rome",
    toolName: "Node",
    appSubtitle: "Node · Container host control",
    loading: "Loading…",
    nav: {
      label: "Views",
      overview: "Overview",
      log: "Computer use log",
    },
    header: {
      themeLight: "Switch to light mode",
      themeDark: "Switch to dark mode",
      themeSystem: "Follow system appearance",
      switchLanguage: "Switch language (简体中文)",
      signOut: "Lock UI",
      refresh: "Refresh",
    },
    phase: {
      unconfigured: "Not authorized",
      authorizing: "Authorizing",
      connecting: "Connecting",
      online: "Online",
      retrying: "Reconnecting",
      disconnected: "Disconnected",
      revoked: "Revoked",
      superseded: "Superseded",
      error: "Error",
    } satisfies Record<HostPhase, string>,
    login: {
      title: "Unlock Web UI",
      description: "Enter your Web UI access password to continue.",
      passwordLabel: "Password",
      passwordPlaceholder: "Enter password",
      submit: "Unlock",
      submitting: "Verifying…",
      empty: "Enter your password.",
      setupTitle: "Set up Web UI password",
      setupDescription:
        "Paste the one-time setup token printed to stderr / docker logs and choose a custom password for this Web UI.",
      setupTokenLabel: "One-time setup token",
      setupTokenPlaceholder: "Paste setup token from logs",
      setupTokenEmpty: "Enter the one-time setup token from stderr or docker logs.",
      setupSubmit: "Set password & unlock",
      setupSubmitting: "Setting up…",
    },
    password: {
      title: "Web UI access",
      badgeNone: "Local passwordless",
      badgeFile: "Password set",
      badgeEnv: "Managed by env",
      descriptionNone:
        "Localhost access is passwordless. Set a custom password to protect this UI or enable remote access.",
      descriptionFile: "Custom password protection is active for local and remote access.",
      descriptionEnv:
        "Password is set via ROME_NODE_UI_PASSWORD. Update the container environment to change it.",
      setButton: "Set password",
      changeButton: "Change password",
      removeButton: "Remove password",
      setDialogTitle: "Set Web UI password",
      setDialogDescription:
        "Stored locally as an scrypt hash in the configuration volume. Applies to local and remote access.",
      changeDialogTitle: "Change Web UI password",
      changeDialogDescription:
        "Enter your current password and choose a new password (at least 6 characters).",
      removeDialogTitle: "Remove Web UI password?",
      removeDialogDescription:
        "This restores passwordless localhost access and blocks non-loopback remote hosts.",
      currentLabel: "Current password",
      newLabel: "New password",
      confirmLabel: "Confirm password",
      minLengthHint: "At least 6 characters.",
      mismatch: "Passwords do not match.",
      tooShort: "Password must be at least 6 characters.",
      currentRequired: "Enter your current password.",
      save: "Save password",
      saving: "Saving…",
      removeConfirm: "Remove password",
      removing: "Removing…",
    },
    overview: {
      statusTitle: "Host status",
      statusDescription: "Live Gateway link and local audit health on this container.",
      uptime: "In current state",
      deviceName: "Device name",
      deviceId: "Device ID",
      cloudOrigin: "Rome Cloud",
      platform: "Platform",
      auditState: "Audit log",
      auditOk: "Healthy",
      auditUnavailable: "Unavailable",
      auditCloudHint: "Inspect local requests in Computer use log or manage devices in Rome Cloud.",
      viewLog: "View log",
      openCloud: "Open Rome Cloud",
      auditUnavailableTitle: "Audit log unavailable — remote requests are refused",
      auditUnavailableHint:
        "Check container volume permissions and free disk space, or inspect the database with rome-node audit status.",
      notLinked: "Not linked yet",

      authorizeTitle: "Device authorization",
      authorizeDescription:
        "Link this container to your Rome Cloud account using OAuth2 device authorization. No callback port is required.",
      deviceNameLabel: "Device name",
      deviceNameHint: "Shown on Settings → Devices in Rome.",
      cloudUrlLabel: "Rome Cloud URL",
      cloudUrlHint: "HTTPS origin, or loopback HTTP for local development.",
      startAuth: "Authorize device",
      startingAuth: "Requesting code…",
      reauthorize: "Re-authorize device",
      cancelAuth: "Cancel",
      openVerification: "Open Rome Cloud",
      copyCode: "Copy code",
      copied: "Copied",
      userCodeLabel: "User code",
      verificationHint:
        "Open the verification link in your browser, confirm the user code, and approve this device.",
      expiresIn: (text: string) => `Expires in ${text}`,
      expired: "Expired — start authorization again.",

      controlsTitle: "Connection & execution",
      controlsDescription:
        "Control whether this node stays online and whether Rome instances in your account can run programs.",
      connect: "Connect",
      disconnect: "Disconnect",
      reconnect: "Reconnect",
      executionLabel: "Allow remote execution",
      executionOnHint:
        "Authorized callers in your account can run programs, list folders, and copy files as the container user.",
      executionOffHint:
        "Node stays connected in limited mode and refuses every remote action with computer_use_off.",
      resetTitle: "Reset local credential",
      resetDescription:
        "Disconnect and delete credential.json on this node. You will need a new Rome Cloud approval to link it again.",
      resetButton: "Reset credential",
      resetDialogTitle: "Reset local device credential?",
      resetDialogBody:
        "This disconnects the container and removes its stored device credential. Existing audit log records are preserved.",
      resetConfirm: "Reset credential",
      cancel: "Cancel",
      revokedNotice:
        "This device authorization was revoked or rejected by Rome Cloud. Authorize the container again to restore access.",
      supersededNotice:
        "Another process connected with the same device credential and replaced this session.",
    },
    log: {
      title: "Computer use log",
      thisNode: "This node",
      storageMeta: (size: string, requests: number, days: number) =>
        `${size} · ${requests.toLocaleString("en")} requests · ${days}d retention`,
      unavailableSuffix: "Remote requests to this node are refused until it is fixed.",
      unavailable: {
        sqlite_missing: {
          title: "This runtime cannot write an audit log.",
          next: "Run Rome Node on Node.js 24+ with built-in SQLite support.",
        },
        newer_schema: {
          title: "The audit log was written by a newer version of Rome Node.",
          next: "Update Rome Node. The database file is left untouched.",
        },
        unreadable: {
          title: "The audit log file cannot be read.",
          next: "Stop the node and move the file aside to keep it. Rome never deletes it; a new log starts on the next launch.",
        },
        io: {
          title: "The audit log cannot be written.",
          next: "Check volume permissions and free disk space. Rome retries when the next request arrives.",
        },
      } satisfies Record<AuditUnavailableCode, { title: string; next: string }>,
      detail: {
        defaultCwd: "where Rome Node runs",
        process: "Process",
        direction: "Direction",
        path: "Path",
        size: "Size",
        sha256: "SHA-256",
        replacedFile: "Replaced file",
        replacedNone: "none",
        acknowledged: "Acknowledged",
        entries: "Entries",
        requestId: "Request ID",
        from: "From",
        unverified: "Unverified",
        unverifiedTitle: "Reported by Rome Cloud. This node cannot verify it.",
        environment: "Environment",
        envSummary: (count: number) => `${count} names, no values`,
        noEndNotice: "No end record: the node stopped while this ran, or it is still running.",
        interruptedNotice:
          "Interrupted: the connection was replaced while this ran, and no reply was sent.",
        largePushNotice: "Larger than 10 MiB, so only its size and SHA-256 are kept.",
        recordTruncatedNotice: "Very long fields were shortened for display.",
        truncatedBadge: (kept: string) => `Truncated · kept ${kept}`,
        truncatedPreview: (shown: string) => `\n… first ${shown} shown`,
        binaryNotice: (size: string) => `Binary payload (${size}) — preview omitted.`,
        prunedNotice: "Removed by the retention rule.",
        contentLoadFailed: "Could not load content preview.",
        loadingPreview: "Loading preview…",
      },
    },
  },
  "zh-CN": {
    brandName: "Rome",
    toolName: "Node",
    appSubtitle: "Node · 容器节点控制面",
    loading: "加载中…",
    nav: {
      label: "视图切换",
      overview: "概览",
      log: "电脑操作记录",
    },
    header: {
      themeLight: "切换到浅色模式",
      themeDark: "切换到深色模式",
      themeSystem: "跟随系统外观",
      switchLanguage: "切换语言 (English)",
      signOut: "锁定界面",
      refresh: "刷新",
    },
    phase: {
      unconfigured: "未授权",
      authorizing: "等待授权",
      connecting: "连接中",
      online: "在线",
      retrying: "重连中",
      disconnected: "已断开",
      revoked: "已撤销",
      superseded: "连接被替换",
      error: "异常",
    } satisfies Record<HostPhase, string>,
    login: {
      title: "解锁控制面",
      description: "请输入你设置的 Web UI 访问密码以继续。",
      passwordLabel: "访问密码",
      passwordPlaceholder: "输入密码",
      submit: "解锁",
      submitting: "验证中…",
      empty: "请输入访问密码。",
      setupTitle: "初始化访问密码",
      setupDescription:
        "请输入启动日志（stderr / docker logs）中的一次性初始化令牌，并设置 Web UI 访问密码。",
      setupTokenLabel: "一次性初始化令牌",
      setupTokenPlaceholder: "粘贴日志中的初始化令牌",
      setupTokenEmpty: "请输入启动日志中的一次性初始化令牌。",
      setupSubmit: "设置密码并进入",
      setupSubmitting: "正在初始化…",
    },
    password: {
      title: "Web UI 访问保护",
      badgeNone: "本机免密",
      badgeFile: "已设密码",
      badgeEnv: "环境变量控制",
      descriptionNone: "本机访问默认免密。可设置自定义密码以保护控制面或开启远程访问。",
      descriptionFile: "已启用自定义密码保护，本地与远程访问均需密码解锁。",
      descriptionEnv: "当前密码由 ROME_NODE_UI_PASSWORD 环境变量控制，如需修改请更新容器配置。",
      setButton: "设置密码",
      changeButton: "修改密码",
      removeButton: "移除密码",
      setDialogTitle: "设置 Web UI 访问密码",
      setDialogDescription:
        "密码以 scrypt 哈希保存在配置卷中，设置后本地与远程访问均需使用该密码解锁。",
      changeDialogTitle: "修改 Web UI 访问密码",
      changeDialogDescription: "输入当前密码并设置新密码（至少 6 位）。",
      removeDialogTitle: "确认移除访问密码？",
      removeDialogDescription:
        "移除后将恢复仅本机（localhost / 127.0.0.1）免密访问，远程主机访问会被拒绝。",
      currentLabel: "当前密码",
      newLabel: "新密码",
      confirmLabel: "确认新密码",
      minLengthHint: "至少 6 位字符。",
      mismatch: "两次输入的密码不一致。",
      tooShort: "密码长度至少为 6 位。",
      currentRequired: "请输入当前密码。",
      save: "保存密码",
      saving: "保存中…",
      removeConfirm: "确认移除",
      removing: "移除中…",
    },
    overview: {
      statusTitle: "节点状态",
      statusDescription: "当前容器的 Gateway 连接与本地审计健康状态。",
      uptime: "当前状态持续",
      deviceName: "设备名称",
      deviceId: "设备 ID",
      cloudOrigin: "Rome Cloud",
      platform: "运行平台",
      auditState: "审计日志",
      auditOk: "正常",
      auditUnavailable: "不可用",
      auditCloudHint: "可在「电脑操作记录」查看本机完整请求，或在 Rome Cloud 管理设备。",
      viewLog: "查看日志",
      openCloud: "打开 Rome Cloud",
      auditUnavailableTitle: "审计日志不可用 — 所有远程请求将被拒绝",
      auditUnavailableHint:
        "请检查容器挂载卷权限与磁盘空间，或在容器内运行 rome-node audit status 查看详情。",
      notLinked: "尚未绑定",

      authorizeTitle: "设备授权",
      authorizeDescription:
        "通过 OAuth2 Device Code 将当前容器绑定到你的 Rome Cloud 账号，无需回调端口。",
      deviceNameLabel: "设备名称",
      deviceNameHint: "将在 Rome 的「设置 → 设备」中显示。",
      cloudUrlLabel: "Rome Cloud 地址",
      cloudUrlHint: "需使用 HTTPS 地址（本地调试可使用 loopback HTTP）。",
      startAuth: "开始设备授权",
      startingAuth: "获取授权码…",
      reauthorize: "重新授权设备",
      cancelAuth: "取消授权",
      openVerification: "打开 Rome Cloud 批准",
      copyCode: "复制验证码",
      copied: "已复制",
      userCodeLabel: "用户验证码",
      verificationHint: "点击打开验证链接，确认验证码一致并批准当前容器接入。",
      expiresIn: (text: string) => `剩余有效时间 ${text}`,
      expired: "授权码已过期，请重新发起授权。",

      controlsTitle: "连接与执行控制",
      controlsDescription:
        "管理容器与 Gateway 的在线状态，以及是否允许账号内的 Rome 实例执行命令。",
      connect: "连接",
      disconnect: "断开连接",
      reconnect: "重新连接",
      executionLabel: "允许远程执行（Computer Use）",
      executionOnHint:
        "开启后，账号内已授权实例可以以当前容器用户身份执行命令、列出目录与传输文件。",
      executionOffHint: "关闭后节点仍保持在线，但会以 computer_use_off 拒绝所有远程执行请求。",
      resetTitle: "清除本地凭证",
      resetDescription:
        "断开连接并删除本节点的 credential.json，下次接入需重新通过 Rome Cloud 批准。",
      resetButton: "清除凭证",
      resetDialogTitle: "确认清除本地设备凭证？",
      resetDialogBody: "此操作将断开容器连接并删除本地保存的设备凭证，已有审计日志不会被删除。",
      resetConfirm: "确认清除",
      cancel: "取消",
      revokedNotice: "设备授权已被 Rome Cloud 撤销或失效，请重新发起设备授权以恢复接入。",
      supersededNotice: "另一进程使用了相同设备凭证上线，当前连接已被替换。",
    },
    log: {
      title: "电脑操作记录",
      thisNode: "当前节点",
      storageMeta: (size: string, requests: number, days: number) =>
        `${size} · ${requests.toLocaleString("zh-CN")} 条请求 · 保留 ${days} 天`,
      unavailableSuffix: "在修复前，本节点将拒绝所有远程请求。",
      unavailable: {
        sqlite_missing: {
          title: "当前运行环境无法写入审计日志。",
          next: "请使用支持内置 SQLite 的 Node.js 24+ 运行 Rome Node。",
        },
        newer_schema: {
          title: "审计日志由更高版本的 Rome Node 写入。",
          next: "请升级 Rome Node，原数据库文件保持原样未被修改。",
        },
        unreadable: {
          title: "审计日志文件无法读取。",
          next: "请停止节点并将该文件移到其他位置备份。Rome 不会自动删除它，下次启动将创建新日志。",
        },
        io: {
          title: "无法写入审计日志。",
          next: "请检查挂载卷权限和剩余磁盘空间，下次收到请求时 Rome 会自动重试。",
        },
      } satisfies Record<AuditUnavailableCode, { title: string; next: string }>,
      detail: {
        defaultCwd: "Rome Node 运行目录",
        process: "进程 PID",
        direction: "传输方向",
        path: "路径",
        size: "大小",
        sha256: "SHA-256",
        replacedFile: "被覆盖文件",
        replacedNone: "无",
        acknowledged: "已确认大小",
        entries: "目录项数",
        requestId: "请求 ID",
        from: "来源",
        unverified: "未验证",
        unverifiedTitle: "由 Rome Cloud 上报，当前节点无法独立验证。",
        environment: "环境变量",
        envSummary: (count: number) => `${count} 个变量名（不记录值）`,
        noEndNotice: "无结束记录：节点在执行期间停止，或该请求仍在运行中。",
        interruptedNotice: "已中断：执行期间连接被替换，未发送响应。",
        largePushNotice: "文件大于 10 MiB，仅保留其大小与 SHA-256 校验值。",
        recordTruncatedNotice: "部分超长字段已截断显示。",
        truncatedBadge: (kept: string) => `已截断 · 保留 ${kept}`,
        truncatedPreview: (shown: string) => `\n… 仅展示前 ${shown}`,
        binaryNotice: (size: string) => `二进制内容（${size}），已省略文本预览。`,
        prunedNotice: "该内容已按保留策略清理。",
        contentLoadFailed: "无法加载内容预览。",
        loadingPreview: "正在加载预览…",
      },
    },
  },
} as const;

export type Messages = (typeof messages)[Locale];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
