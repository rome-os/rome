import type { NodeConnectionStatus, NodeConsoleDaemonState, NodeOutcome } from "./protocol.js";

/** Every string the console shows. `{name}` placeholders are filled by `format`. */
export interface NodeConsoleMessages {
  link: Record<"connecting" | NodeConsoleDaemonState, string>;
  connection: Record<NodeConnectionStatus, string>;
  callerLabel: string;
  since: string;
  reconnects: string;
  runningCount: string;
  service: string;
  running: string;
  history: string;
  search: string;
  searchPlaceholder: string;
  searchHint: string;
  device: string;
  allDevices: string;
  outcomeFilter: string;
  allOutcomes: string;
  direction: string;
  allDirections: string;
  sent: string;
  received: string;
  loading: string;
  empty: string;
  loadMore: string;
  exitCode: string;
  output: string;
  copied: string;
  bytes: string;
  truncated: string;
  to: string;
  from: string;
  outcome: Record<NodeOutcome | "running", string>;
  detail: Record<
    "device" | "action" | "started" | "duration" | "cwd" | "error" | "exit" | "bytes",
    string
  >;
}

const en: NodeConsoleMessages = {
  link: {
    connecting: "Connecting to the device service…",
    not_running: "The device service is not running, so no activity is recorded.",
    not_configured: "Device access is not configured, so no activity is recorded.",
    incompatible: "The device service runs an older version. Restart it to show activity.",
    disconnected: "The device service stopped. Reconnecting…",
  },
  connection: {
    online: "Connected",
    stopped: "Idle",
    connecting: "Connecting",
    retrying: "Reconnecting",
    revoked: "Access revoked",
    superseded: "Connection replaced",
  },
  callerLabel: "Gateway connection",
  since: "For",
  reconnects: "Reconnects",
  runningCount: "Running",
  service: "Service version {version}, started {time}.",
  running: "Running on your computers",
  history: "Sent commands",
  search: "Search commands",
  searchPlaceholder: "Search commands, arguments, and folders",
  searchHint: "Type at least three characters to search.",
  device: "Device",
  allDevices: "All devices",
  outcomeFilter: "Result",
  allOutcomes: "All results",
  direction: "Direction",
  allDirections: "Sent and received",
  sent: "Sent",
  received: "Received",
  loading: "Loading history…",
  empty: "No commands match.",
  loadMore: "Load older",
  exitCode: "Exit {code}",
  output: "{size} output",
  copied: "{size} copied",
  bytes: "stdin {stdin}, stdout {stdout}, stderr {stderr}",
  truncated: "Long text is shortened here. The full text stays in the activity log.",
  to: "To {device}",
  from: "From {device}",
  outcome: {
    running: "Running",
    ok: "Succeeded",
    error: "Failed",
    unknown_outcome: "Unknown result",
    interrupted: "Interrupted",
    aborted: "Canceled",
  },
  detail: {
    device: "Device",
    action: "Action",
    started: "Started",
    duration: "Duration",
    cwd: "Folder",
    error: "Error",
    exit: "Exit code",
    bytes: "Bytes",
  },
};

const zhCN: NodeConsoleMessages = {
  link: {
    connecting: "正在连接设备服务…",
    not_running: "设备服务未运行，因此没有记录活动。",
    not_configured: "尚未配置设备访问，因此没有记录活动。",
    incompatible: "设备服务版本较旧。重启后即可显示活动。",
    disconnected: "设备服务已停止。正在重新连接…",
  },
  connection: {
    online: "已连接",
    stopped: "空闲",
    connecting: "正在连接",
    retrying: "正在重连",
    revoked: "授权已撤销",
    superseded: "连接已被替换",
  },
  callerLabel: "Gateway 连接",
  since: "持续",
  reconnects: "重连次数",
  runningCount: "运行中",
  service: "服务版本 {version}，启动于 {time}。",
  running: "正在你的电脑上运行",
  history: "已发送的命令",
  search: "搜索命令",
  searchPlaceholder: "搜索命令、参数和目录",
  searchHint: "至少输入三个字符才能搜索。",
  device: "设备",
  allDevices: "全部设备",
  outcomeFilter: "结果",
  allOutcomes: "全部结果",
  direction: "方向",
  allDirections: "发送和接收",
  sent: "发送",
  received: "接收",
  loading: "正在加载历史…",
  empty: "没有匹配的命令。",
  loadMore: "加载更早的记录",
  exitCode: "退出码 {code}",
  output: "输出 {size}",
  copied: "已复制 {size}",
  bytes: "stdin {stdin}，stdout {stdout}，stderr {stderr}",
  truncated: "较长的文本在此处被截短。完整文本保存在活动日志中。",
  to: "发往 {device}",
  from: "来自 {device}",
  outcome: {
    running: "运行中",
    ok: "成功",
    error: "失败",
    unknown_outcome: "结果未知",
    interrupted: "已中断",
    aborted: "已取消",
  },
  detail: {
    device: "设备",
    action: "操作",
    started: "开始时间",
    duration: "耗时",
    cwd: "目录",
    error: "错误",
    exit: "退出码",
    bytes: "字节数",
  },
};

/** Chinese for any `zh` locale, English otherwise. */
export function messagesFor(locale: string | undefined): NodeConsoleMessages {
  return locale?.toLowerCase().startsWith("zh") ? zhCN : en;
}

/** Fills `{name}` placeholders. format("Exit {code}", { code: 1 }) returns "Exit 1". */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
