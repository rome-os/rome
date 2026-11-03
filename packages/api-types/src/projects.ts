export interface ProjectDashboardUsageAmounts {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One provider's share of a usage figure. `provider` is the accounting id the
 * model provider reported (`anthropic`, `openai`), or `unknown` for usage
 * recorded without one.
 */
export interface ProjectDashboardProviderUsage extends ProjectDashboardUsageAmounts {
  provider: string;
}

export interface ProjectDashboardUsageDay extends ProjectDashboardUsageAmounts {
  date: string;
  /** The day's figures split by provider. */
  providers: ProjectDashboardProviderUsage[];
}

export interface ProjectDashboardProviderUsageTotals {
  month: ProjectDashboardProviderUsage[];
  total: ProjectDashboardProviderUsage[];
}

export interface ProjectDashboardChat {
  createdAt: string;
  id: string;
  messageCount: number;
  searchText: string;
  snippet: string;
  title: string;
  updatedAt: string;
}

export interface ProjectDashboardStats {
  cacheHitRate: number;
  chatCount: number;
  monthBudgetUsd: number | null;
  monthCostUsd: number;
  monthTokens: number;
  totalCostUsd: number;
  totalTokens: number;
}

export interface ProjectDashboardChatPage {
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
  total: number;
}

export interface ProjectDashboardChatsResponse {
  chats: ProjectDashboardChat[];
  page: ProjectDashboardChatPage;
}

export interface ProjectDashboardResolveResponse {
  logicalPath: string;
  relativePath: string;
}

export interface ProjectDashboardResponse {
  availableProjectPaths: string[];
  chats: ProjectDashboardChat[];
  chatPage: ProjectDashboardChatPage;
  logicalPath: string;
  name: string;
  relativePath: string;
  stats: ProjectDashboardStats;
  usage: ProjectDashboardUsageDay[];
  /** All-time and this-month figures split by provider. */
  providerUsage: ProjectDashboardProviderUsageTotals;
}
