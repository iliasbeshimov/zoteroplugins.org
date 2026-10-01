import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "pipeline", include: ["test/**/*.test.ts"] },
});
