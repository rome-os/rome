import type { NodeActionResult, NodeConnectionStatus, NodeConsoleDaemonState } from "./protocol.js";
import type { NodeDeviceStatus } from "./types.js";

type Plural = { one: string; other: string };

/** Every string the device pages show. `{name}` placeholders are filled by `format`. */
export interface NodeUiMessages {
  link: Record<"connecting" | NodeConsoleDaemonState, string>;
  /** The Gateway connections that need attention. A healthy one shows no text. */
  gateway: Record<Extract<NodeConnectionStatus, "retrying" | "revoked" | "superseded">, string>;
  title: string;
  linkDevice: string;
  linkDialog: {
    title: string;
    commandHelp: string;
    access: string;
    instructions: string;
    close: string;
  };
  status: Record<NodeDeviceStatus, string>;
  revokedDevices: string;
  noDevices: string;
  statsUnavailable: string;
  card: {
    /** The name of a device's curve. */
    chart: Plural;
  };
  chart: {
    label: string;
    dayAgo: string;
    halfDayAgo: string;
    now: string;
    readout: string;
    failed: string;
    noResult: string;
    running: string;
  };
  back: string;
  thisDevice: {
    label: string;
    connecting: string;
    disabled: string;
  };
  manage: {
    menu: string;
    rename: string;
    renameTitle: string;
    nameLabel: string;
    nameHint: string;
    save: string;
    cancel: string;
    connect: string;
    disconnect: string;
    disconnectTitle: string;
    disconnectSelf: string;
    remove: string;
    removeTitle: string;
    /** The remove dialog's first line, then one point per consequence. */
    removeLead: string;
    removeActive: string[];
    removeRevoked: string[];
    removeOnCloud: string;
    errors: Record<
      "device_not_found" | "invalid_device_name" | "revocation_pending" | "unavailable",
      string
    >;
  };
  detail: {
    commandsInDay: Plural;
    average: string;
    peakAt: string;
    failedShare: string;
    resultFilter: string;
    search: string;
    searchPlaceholder: string;
    searchHint: string;
    count: Plural;
    window: string;
    clearWindow: string;
    columns: Record<"time" | "command" | "duration" | "result", string>;
    today: string;
    yesterday: string;
    loading: string;
    empty: string;
    loadMore: string;
    select: string;
    close: string;
  };
  result: Record<NodeActionResult | "all", string>;
  exitCode: string;
  command: {
    copy: string;
    copied: string;
    started: string;
    duration: string;
    exit: string;
    signal: string;
    error: string;
    output: string;
    errors: string;
    shell: string;
    cwd: string;
    action: string;
    transfer: string;
    truncated: string;
  };
}

const en: NodeUiMessages = {
  link: {
    connecting: "Connecting to the device service…",
    not_running: "The device service is not running, so no activity is recorded.",
    not_configured: "Device access is not configured, so no activity is recorded.",
    incompatible: "The device service runs an older version. Restart it to show activity.",
    disconnected: "The device service stopped. Reconnecting…",
  },
  gateway: {
    retrying: "Reconnecting to Gateway",
    revoked: "Gateway access revoked",
    superseded: "Gateway connection replaced",
  },
  title: "Devices",
  linkDevice: "Link device",
  linkDialog: {
    title: "Link a computer",
    commandHelp:
      "With Rome Node installed, run this in a terminal on the computer you want Rome to use, not on the Rome server.",
    access:
      "Approve access in the browser with the same Rome Cloud account. This allows Rome to run programs as your OS user. Keep the terminal open; Ctrl+C disconnects.",
    instructions: "Installation and connection guide",
    close: "Close",
  },
  status: {
    connected: "Connected",
    not_connected: "Not connected",
    unknown: "Unknown",
    revoked: "Access revoked",
  },
  revokedDevices: "Revoked",
  noDevices: "No computers are linked to this account.",
  statsUnavailable: "Restart the device service to show command counts.",
  card: {
    chart: { one: "{count} command in 24 h", other: "{count} commands in 24 h" },
  },
  chart: {
    label: "Commands per 10 minutes over the last 24 hours",
    dayAgo: "−24 h",
    halfDayAgo: "−12 h",
    now: "now",
    readout: "{from}–{to} · {count}",
    failed: "{count} failed",
    noResult: "{count} no result",
    running: "{count} running",
  },
  back: "Devices",
  thisDevice: {
    label: "This device",
    connecting: "Connecting",
    disabled: "Turned off",
  },
  manage: {
    menu: "Device actions",
    rename: "Rename",
    renameTitle: "Rename device",
    nameLabel: "Name",
    nameHint: "Up to 80 characters. Only the name changes; the device keeps its ID.",
    save: "Save",
    cancel: "Cancel",
    connect: "Connect",
    disconnect: "Disconnect",
    disconnectTitle: "Disconnect {name}?",
    disconnectSelf: "This is this computer, so you can connect it again here at any time.",
    remove: "Remove",
    removeTitle: "Remove {name}?",
    removeLead: "This can't be undone.",
    removeActive: [
      "Your agent can't use {name} anymore.",
      "To add it back, reconnect it. It returns as a new device.",
    ],
    removeRevoked: ["{name} is already revoked, so only its record is deleted."],
    removeOnCloud: "Remove on Rome Cloud",
    errors: {
      device_not_found: "Rome Cloud has no such device in your account.",
      invalid_device_name: "Use 1 to 80 characters without control characters.",
      revocation_pending:
        "The device is revoked, but Rome Cloud has not confirmed it yet. It stays under Revoked; remove it again in a moment.",
      unavailable: "Rome Cloud could not be reached. Try again.",
    },
  },
  detail: {
    commandsInDay: {
      one: "command in the last 24 h",
      other: "commands in the last 24 h",
    },
    average: "avg {rate}/min",
    peakAt: "peak {count} at {time}",
    failedShare: "{rate} failed",
    resultFilter: "Result",
    search: "Search commands",
    searchPlaceholder: "Search commands and folders",
    searchHint: "Type at least three characters to search.",
    count: { one: "{count} command", other: "{count} commands" },
    window: "{from}–{to}",
    clearWindow: "Show the whole 24 h",
    columns: { time: "Time", command: "Command", duration: "Duration", result: "Result" },
    today: "Today",
    yesterday: "Yesterday",
    loading: "Loading commands…",
    empty: "No commands match.",
    loadMore: "Load older",
    select: "Select a command to see its details.",
    close: "Close",
  },
  result: {
    all: "All",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    no_result: "No result",
  },
  exitCode: "exit {code}",
  command: {
    copy: "Copy command",
    copied: "Copied",
    started: "Started",
    duration: "Duration",
    exit: "Exit code",
    signal: "Signal",
    error: "Error",
    output: "Output",
    errors: "Error output",
    shell: "Shell",
    cwd: "Directory",
    action: "Action",
    transfer: "Copy",
    truncated: "Long text is shortened here. The full text stays in the activity log.",
  },
};

const zhCN: NodeUiMessages = {
  link: {
    connecting: "正在连接设备服务…",
    not_running: "设备服务未运行，因此没有记录活动。",
    not_configured: "尚未配置设备访问，因此没有记录活动。",
    incompatible: "设备服务版本较旧。重启后即可显示活动。",
    disconnected: "设备服务已停止。正在重新连接…",
  },
  gateway: {
    retrying: "正在重连 Gateway",
    revoked: "Gateway 授权已撤销",
    superseded: "Gateway 连接已被替换",
  },
  title: "设备",
  linkDevice: "关联设备",
  linkDialog: {
    title: "关联电脑",
    commandHelp:
      "安装 Rome Node 后，在需要让 Rome 使用的电脑终端中运行此命令，而不是在 Rome 服务器上运行。",
    access:
      "在浏览器中使用同一个 Rome Cloud 账户批准访问。这允许 Rome 以当前系统用户身份运行程序。请保持终端开启；按 Ctrl+C 断开连接。",
    instructions: "安装与连接指南",
    close: "关闭",
  },
  status: {
    connected: "已连接",
    not_connected: "未连接",
    unknown: "未知",
    revoked: "授权已撤销",
  },
  revokedDevices: "已撤销",
  noDevices: "此账户尚未关联电脑。",
  statsUnavailable: "重启设备服务后即可显示命令统计。",
  card: {
    chart: { one: "24 小时 {count} 条命令", other: "24 小时 {count} 条命令" },
  },
  chart: {
    label: "最近 24 小时每 10 分钟的命令数",
    dayAgo: "−24 小时",
    halfDayAgo: "−12 小时",
    now: "现在",
    readout: "{from}–{to} · {count}",
    failed: "{count} 失败",
    noResult: "{count} 无结果",
    running: "{count} 运行中",
  },
  back: "设备",
  thisDevice: {
    label: "本机",
    connecting: "连接中",
    disabled: "已关闭",
  },
  manage: {
    menu: "设备操作",
    rename: "重命名",
    renameTitle: "重命名设备",
    nameLabel: "名称",
    nameHint: "最多 80 个字符。只改名称，设备 ID 不变。",
    save: "保存",
    cancel: "取消",
    connect: "连接",
    disconnect: "断开",
    disconnectTitle: "断开 {name}？",
    disconnectSelf: "这是本机，断开后可以随时在这里重新连接。",
    remove: "移除",
    removeTitle: "移除 {name}？",
    removeLead: "此操作无法撤销。",
    removeActive: [
      "你的 Agent 将不能再使用 {name}。",
      "要加回来，需要重新连接，它会作为一台新设备出现。",
    ],
    removeRevoked: ["{name} 的授权已撤销，这里只删除它的记录。"],
    removeOnCloud: "在 Rome Cloud 上移除",
    errors: {
      device_not_found: "你的账号中没有这台设备。",
      invalid_device_name: "请使用 1 到 80 个字符，不含控制字符。",
      revocation_pending:
        "设备已撤销授权，但 Rome Cloud 还没确认，暂时留在“已撤销”中。请稍后再移除一次。",
      unavailable: "无法连接 Rome Cloud，请重试。",
    },
  },
  detail: {
    commandsInDay: { one: "条命令（最近 24 小时）", other: "条命令（最近 24 小时）" },
    average: "平均 {rate}/分钟",
    peakAt: "峰值 {count}，{time}",
    failedShare: "{rate} 失败",
    resultFilter: "结果",
    search: "搜索命令",
    searchPlaceholder: "搜索命令和目录",
    searchHint: "至少输入三个字符才能搜索。",
    count: { one: "{count} 条命令", other: "{count} 条命令" },
    window: "{from}–{to}",
    clearWindow: "显示全部 24 小时",
    columns: { time: "时间", command: "命令", duration: "耗时", result: "结果" },
    today: "今天",
    yesterday: "昨天",
    loading: "正在加载命令…",
    empty: "没有匹配的命令。",
    loadMore: "加载更早的记录",
    select: "选择一条命令查看详情。",
    close: "关闭",
  },
  result: {
    all: "全部",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    no_result: "无结果",
  },
  exitCode: "退出码 {code}",
  command: {
    copy: "复制命令",
    copied: "已复制",
    started: "开始时间",
    duration: "耗时",
    exit: "退出码",
    signal: "信号",
    error: "错误",
    output: "输出",
    errors: "错误输出",
    shell: "Shell",
    cwd: "目录",
    action: "操作",
    transfer: "复制文件",
    truncated: "较长的文本在此处被截短。完整文本保存在活动日志中。",
  },
};

/** Chinese for any `zh` locale, English otherwise. */
export function messagesFor(locale: string | undefined): NodeUiMessages {
  return locale?.toLowerCase().startsWith("zh") ? zhCN : en;
}

/** Fills `{name}` placeholders. format("Exit {code}", { code: 1 }) returns "Exit 1". */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** Picks the form for `count` and fills `{count}` with it, formatted for `locale`. */
export function plural(
  forms: Plural,
  count: number,
  locale: string | undefined,
  values: Record<string, string | number> = {},
): string {
  const form = new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other;
  return format(form, { count: count.toLocaleString(locale), ...values });
}
