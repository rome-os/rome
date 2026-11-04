// The connection kinds whose accounts are an agent's own, as each kind's
// descriptor in core declares it (`link: "own_account"`), which an app cannot
// read. A core test keeps the two in step. Every other channel
// carries the guardian's own accounts (a linked WhatsApp, a WeChat login) or
// Rome's own traffic, and stays out of Dream.
export const ACCOUNT_KINDS = ["feishu", "telegram", "discord", "slack_bot"];

/** Connection kinds whose agent is a delegate on the guardian's own account,
 *  which Dream leaves alone as it does their other personal accounts. */
export const GUARDIAN_OWN_KINDS = ["telegram_user"];
