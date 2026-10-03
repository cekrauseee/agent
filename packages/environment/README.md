# Environment helpers

Native Node env-file normalization shared by database and application setup. `mergeEnv` preserves
nonempty raw quoted values, collapses duplicate assignments and uses the example as an allowlist.
`writeEnv` replaces a file atomically with mode 0600. `prepareEnv` combines them with owned-port
validation and local session-secret handling; it normalizes only the supplied directory. Commented
example assignments are optional overrides.

No external credential is fabricated. Missing external values stay blank; quoted `$NAME` remains
literal. Existing session secrets shorter than 32 characters fail before replacing the file.

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` in this directory. Tests use
temporary fixtures and never operate on real project env files or containers. The
[environment workflow](../../.github/workflows/environment.yml) runs for this package and its
declared tooling dependencies.

`loadEnv` applies process → project → workspace precedence using native Node parsing. `/register`
preloads that hierarchy for worker and migrations; `agent-env` prepares project settings, while this
package's `setup` task prepares the root shared base. See the canonical
[global environment guide](../../docs/environment.md) and
[documentation index](../../docs/README.md).
