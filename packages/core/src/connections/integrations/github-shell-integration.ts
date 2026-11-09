import { spawn } from "node:child_process";
import type { SecretRecord } from "../types.js";
import { createLogger } from "../../logger.js";
import type { OAuthProvider } from "../oauth/oauth-providers.js";

const log = createLogger("github-shell-integration");

function getGhAuthEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

async function runGh(args: string[], stdin?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", args, {
      env: getGhAuthEnv(),
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`gh ${args.join(" ")} timed out.`));
    }, 10_000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }

      finish(new Error(stderr.trim() || `gh ${args.join(" ")} exited with ${code}.`));
    });

    child.stdin.end(stdin);
  });
}

async function configurePersistentGithubCliAuth(accessToken: string): Promise<void> {
  await runGh(
    ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"],
    `${accessToken}\n`,
  );
  await runGh(["auth", "setup-git", "--hostname", "github.com"]);
}

async function clearPersistentGithubCliAuth(): Promise<void> {
  await runGh(["auth", "logout", "--hostname", "github.com", "--yes"]);
}

async function tryConfigurePersistentGithubCliAuth(accessToken: string): Promise<void> {
  try {
    await configurePersistentGithubCliAuth(accessToken);
  } catch (error) {
    log.warn("failed to persist GitHub CLI auth", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function tryClearPersistentGithubCliAuth(): Promise<void> {
  try {
    await clearPersistentGithubCliAuth();
  } catch (error) {
    log.warn("failed to clear GitHub CLI auth", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Configure the in-container `gh`/`git` CLI for the guardian's GitHub OAuth
 * token, read from the grant's secret `material`. This is GitHub's
 * provider-specific shell concern only; the on-disk token file the shell wrappers
 * and the connector read is owned separately by `provider-token-files.ts`
 * (`syncProviderTokenFile`), so the custody hook runs both.
 */
export async function syncGithubShellIntegrationForProvider(
  provider: OAuthProvider,
  material: SecretRecord,
): Promise<void> {
  if (provider !== "github") {
    return;
  }

  const accessToken = material.accessToken?.trim();
  if (!accessToken) {
    await tryClearPersistentGithubCliAuth();
    return;
  }

  await tryConfigurePersistentGithubCliAuth(accessToken);
}

export async function clearGithubShellIntegrationForProvider(
  provider: OAuthProvider,
): Promise<void> {
  if (provider !== "github") {
    return;
  }

  await tryClearPersistentGithubCliAuth();
}
