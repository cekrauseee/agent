import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseEnv } from "node:util";
import { mergeEnv, setup } from "../scripts/setup.mjs";

const template = readFileSync(".env.example", "utf8");

test("setup env upsert preserves raw values and follows the example", () => {
  const existing = '# Old comment\r\nOPENAI_API_KEY="a # value $OTHER"\r\nBETTER_AUTH_SECRET=first\r\nexport BETTER_AUTH_SECRET=abcdefghijklmnopqrstuvwxyz0123456789\r\nGOOGLE_CLIENT_SECRET="line one\nline two\\nline three"\nAPP_PORT=37419\nOBSOLETE_KEY=remove-me\n';
  const output = mergeEnv(template, existing, { BETTER_AUTH_URL: "http://localhost:37419" });
  const values = parseEnv(output);
  const previous = parseEnv(existing);
  for (const key of ["OPENAI_API_KEY", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_SECRET", "APP_PORT"]) assert.equal(values[key], previous[key]);
  assert.ok(output.includes('OPENAI_API_KEY="a # value $OTHER"'));
  assert.equal(values.BETTER_AUTH_URL, "http://localhost:37419");
  assert.equal(values.GOOGLE_CLIENT_ID, "");
  assert.equal(values.OBSOLETE_KEY, undefined);
  assert.deepEqual(Object.keys(values), Object.keys(parseEnv(template)));
  assert.deepEqual(output.split("\n").filter(line => line.startsWith("#")), template.split("\n").filter(line => line.startsWith("#")));
  assert.equal(mergeEnv(template, output), output, "upsert must be idempotent");
  for (const input of ["", 'BETTER_AUTH_SECRET=""\n']) {
    const generated = parseEnv(mergeEnv(template, input));
    assert.ok(generated.BETTER_AUTH_SECRET);
    assert.match(generated.BETTER_AUTH_SECRET, /^[a-f0-9]{64}$/);
    assert.equal(generated.OPENAI_API_KEY, "", "external credentials are never fabricated");
  }
});

test("setup orchestrates reuse, fresh start and migration ordering safely", async () => {
  for (const scenario of ["new", "reuse", "fresh", "volume", "denied", "failed-build"] as const) {
    const root = mkdtempSync(join(tmpdir(), "agent-setup-"));
    writeFileSync(join(root, ".env.example"), template);
    const calls: { executable: string; args: string[]; environment: Record<string, string | undefined> }[] = [];
    let prompts = 0;
    const run = (_root: string, environment: Record<string, string | undefined>, executable: string, args: string[]) => {
      calls.push({ executable, args, environment: { ...environment } });
      if (args.includes("config")) return '{"name":"isolated-setup-test"}';
      if (args.includes("ps")) return scenario === "new" || scenario === "volume" ? "[]" :
        JSON.stringify({ Service: "app", Publishers: [{ PublishedPort: 37419 }] }) + "\n" + JSON.stringify({ Service: "postgres", Publishers: [{ PublishedPort: 57419 }] });
      if (args.includes("ls")) return scenario === "volume" ? "isolated-test-volume\n" : "";
      if (args.includes("build") && scenario === "failed-build") throw new Error("build failed");
      return "";
    };
    try {
      if (scenario === "denied") {
        await assert.rejects(setup(root, run, async () => { prompts++; throw new Error("authorization denied"); }), /authorization denied/);
        assert.equal(prompts, 1);
        assert.equal(calls.some(call => call.args.includes("down")), false);
        assert.equal(calls.some(call => call.executable === "pnpm" && call.args.includes("install")), false);
        assert.throws(() => readFileSync(join(root, ".env")));
        continue;
      }
      const invoke = () => setup(root, run, async () => { prompts++; return scenario === "fresh"; });
      if (scenario === "failed-build") await assert.rejects(invoke(), /build failed/);
      else await invoke();
      assert.equal(prompts, scenario === "new" ? 0 : 1);
      const down = calls.findIndex(call => call.args.includes("down"));
      assert.equal(down !== -1, scenario === "fresh", "data deletion requires affirmative permission");
      if (down !== -1) assert.ok(calls[down].args.includes("--volumes"));
      const values = parseEnv(readFileSync(join(root, ".env"), "utf8"));
      assert.equal(values.APP_PORT, scenario === "new" || scenario === "volume" ? process.env.APP_PORT || "3000" : process.env.APP_PORT || "37419");
      assert.equal(values.DATABASE_URL, `postgresql://agent:agent-local@localhost:${values.POSTGRES_PORT}/agent`);
      assert.equal(values.BETTER_AUTH_URL, `http://localhost:${values.APP_PORT}`);
      assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);
      const migration = calls.findIndex(call => call.args.includes("db:migrate"));
      if (scenario === "failed-build") { assert.equal(migration, -1); continue; }
      const stop = calls.findIndex(call => call.args.includes("stop"));
      const postgresUp = calls.findIndex(call => call.args.includes("up") && call.args.at(-1) === "postgres");
      const consumersUp = calls.findIndex(call => call.args.includes("up") && call.args.at(-1) === "worker");
      assert.ok(stop < migration && postgresUp < migration && migration < consumersUp);
      assert.equal(calls[migration].environment.BETTER_AUTH_SECRET, undefined);
      assert.ok(calls[migration].args.includes(join(root, ".env")), "Compose must load .env directly, including interpolation");
      assert.ok(calls.some(call => call.args.includes("--frozen-lockfile")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("setup fails closed without a terminal for existing data and preserves invalid configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-setup-"));
  writeFileSync(join(root, ".env.example"), template);
  writeFileSync(join(root, ".env"), "BETTER_AUTH_SECRET=too-short\n");
  let mutations = 0;
  const run = (_root: string, _environment: unknown, _executable: string, args: string[]) => {
    if (args.includes("config")) return '{"name":"isolated-setup-test"}';
    if (args.includes("ps")) return '[{"Service":"postgres"}]';
    if (args.includes("down") || args.includes("stop") || args.includes("build") || args.includes("up")) mutations++;
    return "";
  };
  try {
    if (!process.stdin.isTTY) await assert.rejects(setup(root, run), /terminal/);
    await assert.rejects(setup(root, run, async () => false), /too short/);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "BETTER_AUTH_SECRET=too-short\n");
    assert.equal(mutations, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
