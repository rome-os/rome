// The reads a normalizer makes when a raw event carries too little to
// describe: a Linear issue's people, an Outlook message by its id, a Notion
// comment and its page. They run inside the connection, through each
// service's connected account, and are injected so tests need no service.

/** The connected Linear user. */
export interface LinearViewer {
  id: string;
  name?: string;
  displayName?: string;
  email?: string;
}

/** The connected Notion user, who owns Rome's integration in their workspace. */
export interface NotionMe {
  id: string;
  email?: string;
  name?: string;
  workspace?: string;
}

/** Who a Linear issue belongs to. */
export interface LinearIssuePeople {
  assigneeId?: string;
  creatorId?: string;
  subscriberIds: string[];
}

type Json = Record<string, unknown>;

export interface WatchReads {
  linearViewer(): Promise<LinearViewer>;
  linearIssue(id: string): Promise<LinearIssuePeople>;
  /** A Microsoft Graph message, with its headers. */
  outlookMessage(id: string): Promise<Json>;
  notionMe(): Promise<NotionMe>;
  /** A Notion comment object. */
  notionComment(id: string): Promise<Json>;
  /** The comments on a Notion page or block, oldest first. */
  notionComments(blockId: string): Promise<Json[]>;
  /** A Notion page object. */
  notionPage(id: string): Promise<Json>;
}
