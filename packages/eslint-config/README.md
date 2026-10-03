# ESLint configuration

Exports `@agent/eslint-config/node` and `/next`. Consumers declare the package, create an ESLint
entrypoint calling its preset with their project directory, and own their local TypeScript project.
The Next preset retains Core Web Vitals/TypeScript and the Node preset uses TypeScript ESLint.

Both presets reject unused imports/variables and typed deprecated references. Intentionally unused
callback/caught-error parameters may begin with `_`; ordinary variables have no exception. Project
service supplies type information. `eslint-config-prettier` disables conflicting style rules;
formatting runs separately. Framework output is ignored by the shared preset.

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` here. The regression feeds
real deprecated/unused references through both presets. The
[ESLint workflow](../../.github/workflows/eslint-config.yml) runs for this project and its declared
configuration dependencies. Changes also trigger CI for consuming projects.
