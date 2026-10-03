# Conversation interface

Home lives at `/`; an existing conversation lives at `/conversation/[id]`. The route ID identifies
its durable conversation, so direct links, reload, Back and Forward load the same owned history.
Google sign-in is the only entry method. Session expiry returns to the sign-in surface and logout
clears session-scoped client data.

The rail contains Home and the account menu. The Home sidebar contains New Conversation and owned
history. Its expanded form participates in the layout. Collapsing it leaves a floating preview on
Home hover, with keyboard and touch access. Previewing history does not select a conversation. New
Conversation opens an empty Home draft; its first accepted send creates the conversation.

## State and generation

The Home and conversation routes share one session-scoped Zustand provider for profile, preferences,
history, draft and pending actions. The URL and existing private API remain authoritative; inference
remains owned by the durable worker. Route IDs select durable conversations, while accepted
submission IDs identify transient transcript positioning. History and conversation listings load
every page in backend order. The interface chooses reasoning effort for the saved backend model; it
does not provide a model selector. Client code never imports server-only authentication, service
credentials or database modules.

Text and voice use the same submission action. Admission returns canonical user and generation IDs.
An uncertain request retries with the same request UUID and body; changed input starts a new
request. A draft survives rejected admission. Once conversation creation succeeds, retrying
admission reuses that conversation rather than creating another.

The durable worker owns generation; leaving a route or closing the event stream does not cancel it.
The browser reconciles saved snapshots and replayable SSE events, using the application event cursor
rather than provider progress. Terminal output replaces partial streamed text with the canonical
message. Cancel response is explicit. Editing is enabled only after completion or confirmed
cancellation, and only the latest user message is editable. Replacement preserves that user ID,
discards its old assistant response and admits a new generation. A rejected replacement preserves
the editor text. Failed or cancelled responses expose recovery rather than silently appending a
turn.

## Recording

Recording keeps the typed draft and saved selection. Cancel discards audio and preserves the draft.
Stop finalizes and transcribes into the composer. Send finalizes, transcribes and submits the
combined text through the same conversation action. Nonblank transcript text replaces the saved
selection or appends when there was no usable selection. Empty or failed transcription never clears
the draft or sends a message.

The recording surface replaces the input area with cancel at the left, waveform in the center and
stop/send at the right. Audio stays local until finalization; the existing completed-recording
endpoint handles transcription. There is no realtime voice call or live transcript transport.

## Transcript position

Every accepted submission, replacement or retry starts a lifecycle keyed by conversation, user and
generation IDs. It places that user turn near the top of the transcript viewport, including short
conversations. A trailing spacer uses that viewport's actual height, shrinks as output grows and
stops at zero. If user scrolling moves the whole spacer below the viewport, its remaining space is
removed for that lifecycle. Scrolling down, resizing or late events cannot restore it; a new
submission can. History loading and stream reconnection do not fabricate a submission.

Output never continuously follows the reader. Jump to end moves to the current end once; later
output preserves the reading position. The composer is outside the measured transcript viewport.

## Components and appearance

The interface composes official `@shadcn` registry primitives with the requested `b1VlIwYS` preset,
Base UI/Luma defaults and local Geist fonts. Default tokens follow the operating system's light or
dark appearance. Feature classes supply layout and required behavior without another theme system.
Markdown uses `react-markdown` CommonMark with raw HTML disabled and no extra plugins.

## Local verification

Install the locked workspace dependencies, then run from `apps/web`:

```sh
pnpm test:frontend
pnpm format:check
pnpm typecheck
pnpm lint
pnpm build
```

The project's `pnpm test` runs server and frontend tests in separate processes because the React
server condition intentionally excludes browser hooks. Supply `TEST_DATABASE_URL` for the server
database checks as described in the [web guide](../README.md#verification-and-ci); those checks
create and remove isolated temporary databases. Unit checks do not call paid providers. The existing
[web workflow](../../../.github/workflows/web.yml) runs both suites through the project's test
command. See [workspace development](../../../docs/development.md) for shared CI and tooling rules.

For controlled browser verification, start a local app without the generation worker. Use a
dedicated browser session and the init fixture before opening the app:

```sh
pnpm dev --port 3100
pnpm dlx agent-browser --session conversation-qa \
  --init-script "$PWD/tests/frontend/browser-fixture.mjs" open http://localhost:3100
pnpm dlx agent-browser --session conversation-qa snapshot -i
```

Run the integrated scenarios against that server, then the navigation scenarios in the same session:

```sh
CONVERSATION_QA_URL=http://localhost:3100 CONVERSATION_QA_SESSION=conversation-qa \
  node tests/frontend/conversation.browser.mjs
NAVIGATION_QA_URL=http://localhost:3100 NAVIGATION_QA_SESSION=conversation-qa \
  node tests/frontend/navigation.browser.mjs
pnpm dlx agent-browser --session conversation-qa close
```

The conversation scenario uses agent-browser 0.38.1, resets only its dedicated browser session and
checks API admission, reconnection, cancellation, rejected/accepted editing, native transcript
geometry, generated recording and recoverable session expiry. The navigation scenario covers sidebar
pointer/keyboard/mobile behavior, routes and logout. For the focused complete spacer geometry proof,
run `node tests/frontend/scrolling-qa.mjs 3104` after stopping other development servers in the same
checkout. It creates an isolated temporary fixture route, runs its own server and removes the route
and generated temporary types afterward; no QA route ships with the app.

The fixture exists only in tests and is never imported into the app. It intercepts browser API
requests for a simulated session, profile, conversation history, admission, preferences,
transcription and SSE. Unknown API requests fail inside the fixture. It supplies a generated audio
stream to the native recorder/analyser without opening a microphone. Reload retains fixture data in
that browser session. Close the browser session when finished.

Browser controls are available through `window.__conversationFixture`:

| Control                                       | Purpose                                                   |
| --------------------------------------------- | --------------------------------------------------------- |
| `requests`, `state`                           | Inspect intercepted requests and durable fixture data.    |
| `reset()`                                     | Restore the empty fixture and reload.                     |
| `seedHistory(count)`                          | Seed saved turns and return their conversation ID.        |
| `latestGeneration()`                          | Return the latest fixture generation ID.                  |
| `delta(id, text)`, `complete(id, text)`       | Advance streamed output and finish with canonical text.   |
| `fail(id)`, `disconnect(id)`                  | Simulate durable failure or transport closure.            |
| `failNext(path, status, error)`               | Reject the next matching API request.                     |
| `expire()`                                    | Expire the simulated session before the next API request. |
| `transcribe(text)`, `denyMicrophone(boolean)` | Control transcript text or simulated permission denial.   |

Browser fixtures prove interface behavior and real layout under controlled transport. They do not
establish real Google OAuth, microphone/device compatibility or provider recognition/generation.
Those live checks require separate authorization and configuration. Existing backend APIs, worker,
Origin validation and ownership checks continue to apply; there is no development authentication
bypass. See the [API reference](api.md) for complete payloads and [transcription](transcription.md)
for recording limits.
