import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "src/client"),
    },
  },
  test: {
    include: ["test/**/*.{test,spec}.{mjs,ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // The dsh service exports NODE_ENV=production, so a suite run from a dsh
    // session inherits it and every React test dies with "act(...) is not
    // supported in production builds" — an environment artefact that reads
    // exactly like a regression and cost a debugging round. Pin it here rather
    // than in the npm script so a bare `npx vitest run` is safe too.
    env: { NODE_ENV: "test" },
  },
})
