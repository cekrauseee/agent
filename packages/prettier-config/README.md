# Prettier configuration

Exports the formatter configuration and `/ignore`. Consumers declare this package and Prettier, set
`prettier` in their own package manifest, and point the formatter at the exported ignore file. The
common policy uses single quotes including JSX, no semicolons, 100 columns and wrapped Markdown.
Generated framework output, migration artifacts and dependencies are ignored.

There is no root application formatter config or ignore file. This package additionally formats the
workspace's generic manifests, README/instructions and GitHub metadata. Other projects format their
own trees. `pnpm format` writes; `pnpm format:check` verifies without modifying files.

Run formatting, lint, typecheck and tests here. The regression resolves the exported config through
Prettier and formats a TypeScript fixture. The
[Prettier workflow](../../.github/workflows/prettier-config.yml) checks this project and its
declared configuration dependencies. Consumers inherit the same policy without copying it.
