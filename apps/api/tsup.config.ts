import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  // shared ships TypeScript source; bundle it instead of resolving it at runtime
  noExternal: ["@notkocu/shared"],
});
