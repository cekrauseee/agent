# ESLint configuration

Exports `@agent/eslint-config/node` and `/next`. Consumers declare the package, create an ESLint
entrypoint calling its preset with their project directory, and own their local TypeScript project.
The Next preset retains Core Web Vitals/TypeScript and the Node preset uses TypeScript ESLint.

Both presets reject unused imports/variables and typed deprecated references. Intentionally unused
callback/caught-error parameters may begin with `_`; ordinary variables have no exception. Project
service supplies type information. `eslint-config-prettier` disables conflicting style rules;
formatting runs separately. Framework output is ignored by the shared preset.

This package consumes the Prettier and TypeScript policies and owns their executable regressions,
alongside the regression feeding deprecated/unused references through both lint presets. Prettier
has no workspace dependencies; TypeScript uses Prettier; ESLint uses both. Keeping verification in
this consumer avoids circular tooling dependencies without duplicating any policy.

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` here. Use
`pnpm --filter '@agent/eslint-config...' <task>` from the root to include its configuration
dependencies. The three configuration workflows run this same closure, preserving formatter,
compiler and typed lint coverage. Changes also trigger CI for consuming projects.
