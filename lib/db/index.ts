import "server-only";
import { Pool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as neonDrizzle } from "drizzle-orm/neon-serverless";
import { databaseConfig } from "../server/env";
import * as schema from "./schema";

export function createDatabase(config = databaseConfig()) {
  const options = { connectionString: config.url, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };
  if (config.driver === "neon") {
    neonConfig.webSocketConstructor = WebSocket;
    const pool = new NeonPool(options);
    pool.on("error", () => console.error("Unexpected idle Neon connection error"));
    return { db: neonDrizzle(pool, { schema }), close: () => pool.end() };
  }
  const pool = new Pool(options);
  pool.on("error", () => console.error("Unexpected idle PostgreSQL connection error"));
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const globalDatabase = globalThis as typeof globalThis & { agentDatabase?: ReturnType<typeof createDatabase> };
export function getDb(): Database {
  return (globalDatabase.agentDatabase ??= createDatabase()).db;
}
