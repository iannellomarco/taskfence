import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    fileParallelism: false,
    isolate: true,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    restoreMocks: true,
    sequence: {
      concurrent: false,
    },
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
