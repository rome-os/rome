// The guardian's profile: their name and background, and the name they give
// their agent. Vocabulary: docs/domains/people.md.

export { type AgentNameEvents, registerAgentNameAction } from "./actions/agent-name.js";
export {
  applyGuardianProfile,
  applySetupDefaults,
  defaultGuardianName,
  writeGuardianBackground,
} from "./guardian-profile.js";
