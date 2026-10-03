# Prettier configuration

Exports the formatter configuration and `/ignore`. Consumers declare this package and Prettier, set
`prettier` in their own package manifest, and point the formatter at the exported ignore file. The
common policy uses single quotes including JSX, no semicolons, 100 columns and wrapped Markdown.
Generated framework output, migration artifacts and dependencies are ignored.

There is no root application formatter config or ignore file. This package additionally formats the
workspace's generic manifests, README/instructions, global documentation and GitHub metadata. Other
projects format their own trees. `pnpm format` writes; `pnpm format:check` verifies without
modifying files.

Run formatting here. This declarative package has no workspace dependencies. Its regression lives in
the [ESLint consumer](../eslint-config/README.md), where Prettier resolves the exported config and
formats a TypeScript fixture. The [Prettier workflow](../../.github/workflows/prettier-config.yml)
checks the configuration consumer and its dependencies, including lint, types and all three policy
regressions. Consumers inherit the same policy without copying it.
