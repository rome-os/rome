// The card `system:sign_in_ai_tool` shows: the AI Tools page's sign-in for the
// AI tools it names, whether or not another one is signed in. The dashboard
// draws it with the onboarding card's component; a client that does not know
// it draws the row it gives any card it cannot draw.

import { z } from "zod";

/** The kind of the sign-in card among core's own cards. */
export const AI_TOOL_SIGN_IN_CARD_ID = "ai-tool-sign-in-card";

/** The card's props. `aiTools` names, by the agent's names for them, the AI
 *  tools it offers, in order; it answers once one of them is signed in. */
export const aiToolSignInCardPropsSchema = z.object({
  aiTools: z.array(z.enum(["claude", "chatgpt"])).min(1),
});
export type AiToolSignInCardProps = z.infer<typeof aiToolSignInCardPropsSchema>;
