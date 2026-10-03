# Documentation

Global guides describe shared workspace behavior; project guides describe their own implementation.
Keep one canonical explanation and link to it instead of copying it into each project.

## Global guides

- [Development](development.md): install, joint commands, setup order and project CI.
- [Environment hierarchy](environment.md): shared defaults, overrides, precedence and secrets.
- [Workspace map](../README.md): applications and reusable packages.

## Project guides

- [Web](../apps/web/README.md): HTTP API, authentication, pages and transcription.
- [Worker](../apps/worker/README.md): durable generation, replay and cleanup.
- [Backend](../packages/backend/README.md): shared domains, schema, migrations and PostgreSQL.
- [Environment package](../packages/environment/README.md): loader and normalization exports.
- [Test utilities](../packages/test-utils/README.md): isolated database fixtures.
- [ESLint](../packages/eslint-config/README.md), [Prettier](../packages/prettier-config/README.md)
  and [TypeScript](../packages/typescript-config/README.md): shared tooling policies.
