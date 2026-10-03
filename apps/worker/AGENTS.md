# Worker conventions

Read README.md and docs/execution.md before changing worker behavior. Import declared backend
package exports; never import web source. Preserve durable leases, identity guards, replay,
cancellation/cleanup, lazy credentials and safe error projections. Run this project's formatter,
lint, typecheck and controlled provider/database tests. No paid calls or production work without
explicit authorization.
