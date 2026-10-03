# Workspace conventions

Use pnpm and the committed lockfile. The root coordinates the workspace and owns global documentation/shared env defaults. Application
source, tests, scripts, specific guides and env overrides belong to their owning project. Link to
global guides rather than copying shared rules. Reusable code and
configuration must be exported by a declared workspace package. Do not import another app's source.

Read the relevant project README and AGENTS instructions before changing behavior. Preserve public
contracts, secrets and unrelated changes. Run the affected project's format check, tests,
typecheck, lint and build when present; root scripts coordinate those project tasks. Database
checks require TEST_DATABASE_URL and may create/drop only isolated temporary local databases.
Shared formatting, compiler and lint policies live in their configuration packages.

Workflows are project-specific and include declared shared dependencies in their path filters.
Update the affected filters if workspace dependencies change. Live provider calls and production
operations require explicit authorization.
