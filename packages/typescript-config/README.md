# TypeScript configuration

Exports `/base`, `/node` and `/next`. Consumers declare this package and extend a preset from their
own tsconfig. Local includes, paths and output requirements stay with that project; no root tsconfig
contains application or test source. The base preserves strictness, no emit and the installed
workspace's module-resolution policy. The Next preset supplies framework JSX/generated-type
settings; Node consumers supply their own source/test includes.

Run `pnpm format:check` here. This declarative package uses only the shared formatter. Its compiler
regression lives in the [ESLint consumer](../eslint-config/README.md): it compiles a valid native
import and rejects unsafe nullable access using the exported Node preset. The
[TypeScript workflow](../../.github/workflows/typescript-config.yml) checks the configuration
consumer and its dependencies, including lint, types and all three policy regressions. Preset
changes trigger consuming projects' checks.
