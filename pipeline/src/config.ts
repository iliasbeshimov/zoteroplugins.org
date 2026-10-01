import { resolveCacheDir } from "./paths.ts";

export const DEFAULT_LLM_MODEL = "claude-sonnet-5";

export interface AtlasConfig {
  githubToken: string | undefined;
  anthropicApiKey: string | undefined;
  llmModel: string;
  cacheDir: string;
  userAgent: string;
}

/** Reads configuration from the environment. Secrets are never read from files in the repo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  return {
    githubToken: env.GITHUB_TOKEN || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    llmModel: env.ATLAS_LLM_MODEL || DEFAULT_LLM_MODEL,
    cacheDir: resolveCacheDir(env.ATLAS_CACHE_DIR || ".cache"),
    userAgent:
      env.ATLAS_USER_AGENT || "zotero-plugin-atlas (+https://github.com/iliasacademia/zoteroatlas)",
  };
}

export function requireGithubToken(config: AtlasConfig): string {
  if (!config.githubToken) {
    throw new Error(
      "GITHUB_TOKEN is not set. Copy .env.example to .env and add a read-only token.",
    );
  }
  return config.githubToken;
}
