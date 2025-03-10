import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    coverage: {
      provider: "v8", // or 'istanbul'
      reporter: ["text", "json", "html"],
    },
    // Set environment variables for tests to reduce log noise
    env: {
      RAGMATIC_LOG_LEVEL: "error",
      RAGMATIC_LOG_SILENT: "false",
    },
  },
});
