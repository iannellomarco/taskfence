import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "adapters/claude-code": "src/adapters/claude-code.ts",
    "adapters/codex-cli": "src/adapters/codex-cli.ts",
    "adapters/opencode": "src/adapters/opencode.ts",
    "adapters/omp": "src/adapters/omp.ts",
    "adapters/pi": "src/adapters/pi.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: ["zod"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
