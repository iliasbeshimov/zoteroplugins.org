import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export const paths = {
  root: repoRoot,
  curated: join(repoRoot, "data", "plugins"),
  generated: join(repoRoot, "data", "generated"),
  pipelineData: join(repoRoot, "pipeline", "data"),
  siteGenerated: join(repoRoot, "site", "src", "generated"),
};

export function resolveCacheDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}
