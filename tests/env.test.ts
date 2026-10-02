import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseConfig, requiredEnv } from "../lib/server/env";

test("runtime database configuration is independent of NODE_ENV", () => {
  const saved = { ...process.env };
  try {
    process.env = { ...process.env, NODE_ENV: "production" };
    process.env.DATABASE_URL = "postgresql://agent:local@postgres:5432/agent";
    process.env.DATABASE_DRIVER = "postgres";
    assert.equal(databaseConfig().driver, "postgres");
    process.env.DATABASE_DRIVER = "neon";
    assert.equal(databaseConfig().driver, "neon");
    process.env.DATABASE_DRIVER = "invalid";
    assert.throws(databaseConfig, /DATABASE_DRIVER/);
    process.env.DATABASE_DRIVER = "postgres";
    process.env.DATABASE_URL = "https://example.com";
    assert.throws(databaseConfig, /PostgreSQL URL/);
    delete process.env.DATABASE_URL;
    assert.throws(databaseConfig, /DATABASE_URL/);
    process.env.PLATFORM_TEST_SECRET = "  ";
    assert.throws(() => requiredEnv("PLATFORM_TEST_SECRET"), /Missing server configuration/);
  } finally {
    process.env = saved;
  }
});
