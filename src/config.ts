import { z } from "zod";

/**
 * Configuration, validated once at startup.
 *
 * Every setting is read here and nowhere else. Reaching for `process.env` deep
 * inside a module means a missing variable surfaces as an undefined halfway
 * through a request, hours after deploy; validating the whole environment
 * before the server binds turns that into a startup failure with a message
 * naming the variable.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),

  DATABASE_URL: z.string().min(1),
  /** Pool size. Postgres connections are not free; the default is deliberately modest. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  /**
   * The signing secret for session tokens.
   *
   * Refusing a short secret in production is not theatre: HS256 with a weak
   * secret is brute-forceable offline from a single captured token, and the
   * attacker then mints whatever claims they like.
   */
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  /** How long an idempotency key is honoured. Longer than any sane client retry. */
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** How long the outbox worker sleeps when it finds nothing to publish. */
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid configuration:\n${problems}`);
  }

  // A production deployment that is still using the development secret is a
  // configuration mistake worth refusing to start over.
  if (parsed.data.NODE_ENV === "production") {
    if (parsed.data.JWT_SECRET.includes("development")) {
      throw new Error("JWT_SECRET is still the development placeholder");
    }
  }

  return parsed.data;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: forget the cached config so a test can supply its own. */
export function resetConfig(): void {
  cached = undefined;
}
