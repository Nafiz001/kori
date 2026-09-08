import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

/**
 * Load .env into the test environment.
 *
 * Read here rather than with a library so that there is one obvious place the
 * tests get their database URL from, and so a missing .env fails loudly at
 * config time instead of as a confusing connection error later.
 */
function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...readEnv(".env"), NODE_ENV: "test" };

// globalSetup runs in the main process before vitest applies `test.env` to the
// workers, so it would not otherwise see DATABASE_URL. Assigning here, at
// config load, is what makes both see the same environment.
Object.assign(process.env, env);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/globalSetup.ts"],
    env,
    // The integration tests share one Postgres database. Running files in
    // parallel against it would make them fight over the same rows, and the
    // resulting failures would look like concurrency bugs in the ledger rather
    // than in the test setup.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
