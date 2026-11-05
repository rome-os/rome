// The live reads behind the GitHub adapter: the guardian's token, their login,
// and whether they belong to a team.

import { Octokit } from "@octokit/rest";
import { readGithubOAuthToken } from "../../../api/github-proxy.js";
import type { GithubDeps } from "./index.js";

/** A GitHub login changes only with the token, so one read per token is enough. */
const githubLogins = new Map<string, string>();
const teamMembers = new Map<string, { member: boolean; at: number }>();
const TEAM_CACHE_MS = 10 * 60_000;

export async function githubLoginFor(token: string): Promise<string> {
  const cached = githubLogins.get(token);
  if (cached) return cached;
  const { data } = await new Octokit({ auth: token }).rest.users.getAuthenticated();
  githubLogins.set(token, data.login);
  return data.login;
}

/** Whether `login` is an active member of `org/teamSlug`, read with the guardian's token. */
export async function isTeamMember(org: string, teamSlug: string, login: string): Promise<boolean> {
  const key = `${org}/${teamSlug}/${login}`.toLowerCase();
  const cached = teamMembers.get(key);
  if (cached && Date.now() - cached.at < TEAM_CACHE_MS) return cached.member;
  const token = await readGithubOAuthToken();
  if (!token) return false;
  let member = false;
  try {
    const { data } = await new Octokit({ auth: token }).rest.teams.getMembershipForUserInOrg({
      org,
      team_slug: teamSlug,
      username: login,
    });
    member = data.state === "active";
  } catch {
    member = false;
  }
  teamMembers.set(key, { member, at: Date.now() });
  return member;
}

export const liveGithubDeps: GithubDeps = {
  token: () => readGithubOAuthToken(),
  login: githubLoginFor,
  isTeamMember,
};
