# Authentication and preferences

Google is the only login provider. Any Google account can sign in; the application has no domain
allowlist, invitation gate, password login, username or profile editor. Better Auth 1.7.7 uses the
official Drizzle adapter against the shared PostgreSQL schema.
[Google configuration](https://better-auth.com/docs/authentication/google) and
[Next.js integration](https://better-auth.com/docs/integrations/next) describe the supported flows.

## Configuration and Google callback

Set `BETTER_AUTH_URL` to the application's exact public origin, `BETTER_AUTH_SECRET` to a random
secret of at least 32 characters, and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to an existing
Google OAuth web application's credentials. Google credentials are runtime inputs; builds and health
checks require none. Remote origins must use HTTPS; HTTP is allowed only for localhost addresses.
With HTTPS, session cookies are Secure, HttpOnly and SameSite=Lax. Local HTTP cookies remain
HttpOnly and SameSite=Lax.

Configure Google's authorized JavaScript origin as `http://localhost:3000` and redirect URI as
`http://localhost:3000/api/auth/callback/google`, or substitute the actual port/public origin.
Configure Google's consent audience for external accounts; a Google project left in testing may
restrict access to Google's test-user list even though this application accepts any account. Only
`openid email profile` identity scopes are requested. No Google services are provisioned by this
repository.

Better Auth owns `/api/auth/*`, including:

- `POST /api/auth/sign-in/social` with
  `{ "provider": "google", "callbackURL": "http://localhost:3000" }` starts the redirect flow.
- `GET /api/auth/get-session` retrieves the validated session.
- `POST /api/auth/sign-out` invalidates the current database session and clears its cookies.

Send cookies and the exact application `Origin` on mutations. Keep Better Auth's built-in origin,
CSRF, OAuth state and PKCE checks enabled. The auth instance and database are initialized lazily.
Cookie caching is disabled so deleted and expired sessions cannot survive through cached cookie
data. Sessions expire after seven days, with Better Auth's normal session refresh behavior.

Google's `given_name`, `family_name`, email and picture map to profile fields. Missing first/last
names stay nullable; display names are never split to invent a family name. Better Auth's required
internal name uses Google's full name, then given name, then email. Auth extensions are not accepted
as client input. `/update-user` is disabled because profile editing is outside the current API.

## Private API

All custom private routes call `requireOwner(request)` from `@agent/backend/auth` before domain
operations. It validates the Better Auth session and returns its user ID; downstream queries must
additionally constrain each resource by that owner. Other users' resource identifiers should
return 404. Mutations require an `Origin` exactly matching `BETTER_AUTH_URL`; missing, null and
foreign origins return 403. A cookie name or client-supplied owner is never authentication.
`@agent/backend/server/http` provides sanitized API errors, private/no-store JSON responses and
byte-bounded JSON parsing for domain routes.

| Endpoint                    | Behavior                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me`               | Own ID, nullable first/last names, email, image, effective preferences and space ID. Repairs a missing space.                |
| `GET /api/me/preferences`   | Effective `{ model, effort }`.                                                                                               |
| `PATCH /api/me/preferences` | Replace both fields with validated `{ model, effort }`; unknown fields and incompatible pairs return 400. JSON limit: 4 KiB. |
| `GET /api/models`           | Authenticated catalog and defaults.                                                                                          |

Space creation runs after user creation and before session creation. `ensureSpace(ownerId)` also
supports recovery on profile retrieval. PostgreSQL's unique owner constraint and conflict-safe
insertion make repeated/concurrent calls converge on one space. A failed first provision can be
retried without duplicates.

## Shared generation settings

`packages/backend/src/models.ts` exports `MODEL_CATALOG`, `DEFAULT_PREFERENCES`,
`validatePreferences`, `effectivePreferences`, and the `Model`, `Effort`, `Preferences` types.
Generation code must validate request overrides against this same allowlist and snapshot the
effective pair at admission; later preference edits affect future generations only. Invalid stored
pairs fail closed rather than silently selecting another model.

Default: `gpt-6-luna` with `medium`. Luna accepts `none`, `low`, `medium`, `high`, `xhigh`, `max`;
Sol (`gpt-6.1-sol`) accepts `low`, `medium`, `high`, `xhigh`, `max`. These values are independent of
the models executing development work. Official
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) pages document Responses and web
search support; the [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model)
includes family compaction support. The
[background guide](https://developers.openai.com/api/docs/guides/background) documents resumable
background Responses, but does not explicitly enumerate these two IDs. Account-specific model access
and the complete live background/compaction/tool combination require credentialed verification
before production use. No arbitrary client model strings may reach OpenAI.

## Verification limits

`pnpm test` checks mapping, preference validation, origin rejection and body limits without
credentials. Set `TEST_DATABASE_URL` to an isolated local PostgreSQL administrative connection to
also exercise real Better Auth signed-cookie validation, login redirect construction, logout/session
invalidation, expiry, two-user preference isolation, recovery and concurrent space provisioning. The
test creates and removes its own uniquely named database. It does not perform a Google OAuth
exchange or paid OpenAI request, and there is no development auth bypass. Real Google sign-in
remains unverified without Google credentials and explicit manual/browser QA authorization.
