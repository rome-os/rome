import { StatsigUser } from "@statsig/statsig-node-core";

/** The Statsig user a gate is evaluated for: `unitId` as its User ID, plus `email` when given. */
export function statsigUser(unitId: string, email?: string): StatsigUser {
  const user = new StatsigUser({ userID: unitId });
  if (email) user.email = email;
  return user;
}
