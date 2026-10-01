import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["schema", "pipeline", "site"],
  },
});
