# Environment hierarchy

The workspace root owns shared defaults in `.env`, using `.env.example` as its template.
Each project's `.env` contains its specific settings and any deliberate overrides. Application runtime, migration commands and database setup use the shared hierarchy exported by `@agent/environment`.

The precedence is **exported process environment → project files → workspace files**.
Within each scope, the order is `.env.<NODE_ENV>.local`, `.env.local`, `.env.<NODE_ENV>`, then `.env`.
Tests omit `.env.local`. Missing files are optional. Native Node parsing preserves quoted `$NAME`
literally; there is no variable expansion. An explicit empty value is still an override; omit the
assignment to inherit a shared value.

| Scope     | Typical settings                                                                                |
| --------- | ----------------------------------------------------------------------------------------------- |
| Workspace | `DATABASE_DRIVER`, `DATABASE_URL`, `OPENAI_API_KEY`, local `POSTGRES_PORT`                      |
| Web       | Google credentials, Better Auth secret/origin, `APP_PORT`; optional database/provider overrides |
| Worker    | Only database/provider values that differ from shared defaults                                  |
| Backend   | Only database/migration/port values that differ from shared defaults                            |

Project examples show optional shared overrides as commented assignments. Setup leaves them
commented until configured, preserves explicit overrides and writes env files atomically with mode 0600. Root `pnpm setup` prepares the shared base before the database and application settings.
For a single project, first run `pnpm --filter @agent/environment setup`, then its own setup task.

Changing a shared value affects consumers that have no override; values are no longer copied into
each application. Keep the database URL and PostgreSQL port consistent and use the same database
for web and worker. HTTP origin/port and Google's callback remain web-specific. Restart processes
after changing configuration.

Secrets stay in ignored env files or platform-provided process variables. Never put credentials in
`NEXT_PUBLIC_` fields or commit real env files. The shared example contains local database defaults
and empty external credentials; setup does not provision services or perform provider calls.
Deployments may supply process variables alone, without any env files.
