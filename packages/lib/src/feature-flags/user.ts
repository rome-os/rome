import { StatsigUser } from "@statsig/statsig-node-core";
import type { GateAttributes } from "./index.js";

/** The Statsig user a gate is evaluated for: `unitId` as its User ID, plus its email when given. */
export function statsigUser(unitId: string, attributes?: GateAttributes): StatsigUser {
  const user = new StatsigUser({ userID: unitId });
  if (attributes?.email) user.email = attributes.email;
  return user;
}
