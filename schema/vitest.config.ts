import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "schema", include: ["test/**/*.test.ts"] },
});
