export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Process liveness only; Compose gates startup on PostgreSQL readiness. */
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } })
}
