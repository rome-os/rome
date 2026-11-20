import type { AuditItem, AuditResult, HostPhase } from "./types";

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
    appTitle: "Rome Node",
    appSubtitle: "Container host control & local audit log",
    nav: {
      overview: "Connection",
      audit: "Audit log",
      ariaLabel: "Rome Node views",
    },
    header: {
      themeLight: "Switch to light mode",
      themeDark: "Switch to dark mode",
      themeSystem: "Follow system appearance",
      switchLanguage: "中文",
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
      title: "Unlock Rome Node",
      description:
        "Enter the access token configured via ROME_NODE_UI_TOKEN or printed in the container startup logs.",
      tokenLabel: "Access token",
      tokenPlaceholder: "Paste access token",
      submit: "Unlock",
      submitting: "Verifying…",
      empty: "Enter the access token.",
    },
    overview: {
      statusTitle: "Host status",
      statusDescription: "Live Gateway link and local audit storage on this container.",
      connection: "Status",
      uptime: "In current state",
      deviceName: "Device name",
      deviceId: "Device ID",
      cloudOrigin: "Rome Cloud",
      platform: "Platform",
      auditState: "Audit log",
      auditOk: "Healthy",
      auditUnavailable: "Unavailable",
      auditStorage: "Log storage",
      requestsTotal: "Total requests",
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
    audit: {
      title: "Audit log",
      description: "Append-only local record of remote requests handled by this host.",
      unavailableTitle: "Audit log unavailable — remote requests are refused",
      unavailableHint:
        "Check container volume permissions and free disk space, or inspect the database with rome-node audit status.",
      filterLabel: "Filter by result",
      actionFilterLabel: "Filter by action",
      all: "All",
      succeeded: "Succeeded",
      failed: "Failed",
      no_result: "No result",
      searchPlaceholder: "Search command, path, or request ID…",
      clearBucket: "Clear time filter",
      chartTitle: "Last 24 hours",
      chartLegend: "10-minute buckets · click a bar to filter",
      emptyTitle: "No audit records yet",
      emptyDescription: "Remote exec, folder listing, and file copy requests will appear here.",
      noMatchesTitle: "No matching requests",
      noMatchesDescription: "Try clearing the search query or switching result filters.",
      loadMore: "Load older records",
      loading: "Loading…",
      selectPrompt: "Select a request to inspect its details and stored output.",
      detailTitle: "Request details",
      closeDetail: "Close details",
      copyCommand: "Copy command",
      started: "Started",
      duration: "Duration",
      exitCode: "Exit code",
      signal: "Signal",
      errorCode: "Error code",
      cwd: "Working dir",
      pid: "Process PID",
      requestId: "Request ID",
      from: "Sender",
      unverified: "Unverified",
      unverifiedTitle: "Reported by Gateway. Recorded for information only.",
      envVars: "Environment",
      envCount: (n: number) => `${n} names (values omitted)`,
      transferDir: "Direction",
      transferPath: "Path",
      transferSize: "Size",
      entries: "Entries",
      noEnd: "No end record: the host stopped while this request ran, or it is still running.",
      interrupted: "Interrupted: the connection closed before a reply was sent.",
      pruned: "Removed by retention policy.",
      truncatedPayload: (kept: string) => `Truncated · kept ${kept}`,
      previewLimit: "… showing first 256 KiB",
      retention: (days: number, gib: string) =>
        `Retention: ${days} days or ${gib} GiB (local only, never uploaded).`,
    },
  },
  "zh-CN": {
    appTitle: "Rome Node",
    appSubtitle: "容器节点控制面与本地审计日志",
    nav: {
      overview: "连接与控制",
      audit: "审计日志",
      ariaLabel: "Rome Node 视图切换",
    },
    header: {
      themeLight: "切换到浅色模式",
      themeDark: "切换到深色模式",
      themeSystem: "跟随系统外观",
      switchLanguage: "EN",
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
      title: "解锁 Rome Node",
      description: "请输入通过 ROME_NODE_UI_TOKEN 配置或在容器启动日志中打印的访问令牌。",
      tokenLabel: "访问令牌",
      tokenPlaceholder: "粘贴访问令牌",
      submit: "解锁",
      submitting: "验证中…",
      empty: "请输入访问令牌。",
    },
    overview: {
      statusTitle: "节点状态",
      statusDescription: "当前容器的 Gateway 连接状态与本地审计存储信息。",
      connection: "连接状态",
      uptime: "当前状态持续",
      deviceName: "设备名称",
      deviceId: "设备 ID",
      cloudOrigin: "Rome Cloud",
      platform: "运行平台",
      auditState: "审计日志",
      auditOk: "正常",
      auditUnavailable: "不可用",
      auditStorage: "日志占用",
      requestsTotal: "累计请求",
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
    audit: {
      title: "审计日志",
      description: "本地只追加记录当前容器处理的所有远程请求，数据永不上传。",
      unavailableTitle: "审计日志不可用 — 所有远程请求将被拒绝",
      unavailableHint:
        "请检查容器挂载卷权限与磁盘空间，或在容器内运行 rome-node audit status 查看详情。",
      filterLabel: "按结果筛选",
      actionFilterLabel: "按动作筛选",
      all: "全部",
      succeeded: "成功",
      failed: "失败",
      no_result: "无结果",
      searchPlaceholder: "搜索命令、路径或 Request ID…",
      clearBucket: "清除时段筛选",
      chartTitle: "最近 24 小时",
      chartLegend: "每 10 分钟一桶 · 点击柱条可按时段筛选",
      emptyTitle: "暂无审计记录",
      emptyDescription: "远程命令执行、目录浏览与文件复制记录会实时显示在这里。",
      noMatchesTitle: "没有匹配的记录",
      noMatchesDescription: "尝试清空搜索词或切换结果筛选条件。",
      loadMore: "加载更早记录",
      loading: "加载中…",
      selectPrompt: "选择一条请求记录以查看完整参数与存储的输出内容。",
      detailTitle: "请求详情",
      closeDetail: "关闭详情",
      copyCommand: "复制命令",
      started: "开始时间",
      duration: "耗时",
      exitCode: "退出码",
      signal: "信号",
      errorCode: "错误码",
      cwd: "工作目录",
      pid: "进程 PID",
      requestId: "请求 ID",
      from: "调用方",
      unverified: "未校验",
      unverifiedTitle: "由 Gateway 上报，仅作信息记录。",
      envVars: "环境变量",
      envCount: (n: number) => `${n} 个变量名（不含值）`,
      transferDir: "方向",
      transferPath: "路径",
      transferSize: "大小",
      entries: "条目数",
      noEnd: "缺少结束记录：请求执行期间宿主停止，或仍在运行中。",
      interrupted: "已中断：响应发出前连接断开。",
      pruned: "已按保留策略清理。",
      truncatedPayload: (kept: string) => `已截断 · 保留 ${kept}`,
      previewLimit: "… 仅预览前 256 KiB",
      retention: (days: number, gib: string) =>
        `保留策略：${days} 天或 ${gib} GiB（先到为准，仅存本地）。`,
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

export function formatClock(at: number, locale: Locale): string {
  return new Date(at).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDateTime(at: number, locale: Locale): string {
  return new Date(at).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function auditItemResult(item: AuditItem): AuditResult {
  if (!item.end || item.end.outcome === "interrupted") return "no_result";
  return item.end.outcome === "ok" ? "succeeded" : "failed";
}

export function describeAuditItem(item: AuditItem): string {
  const args = (item.record.args ?? {}) as Record<string, unknown>;
  if (item.action === "exec") {
    const command = typeof args.command === "string" ? args.command : "exec";
    const list = Array.isArray(args.args) ? args.args : [];
    return [command, ...list]
      .map((part) => {
        const text = String(part);
        return /^[\w@%+=:,./-]+$/.test(text) ? text : JSON.stringify(text);
      })
      .join(" ");
  }
  if (item.action === "fs.list") {
    return `fs.list ${typeof args.path === "string" ? args.path : "~"}`;
  }
  if (item.action === "transfer.open") {
    return `${String(args.direction ?? "copy")} ${String(args.path ?? "")}`.trim();
  }
  return item.action ?? item.kind;
}
