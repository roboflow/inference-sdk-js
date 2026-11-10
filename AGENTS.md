# AGENTS.md

Guidance for coding agents working in this repository.

## Project

`@roboflow/inference-sdk` runs Roboflow Workflows on live video from the browser through Roboflow
Cloud Streaming. The contract it follows is the Cloud Streaming v1 API (temporary sources, jobs,
`hold-preview`, `watch`, `results/subscribe` and the processor's WebSocket results feed) on
`https://api.roboflow.com` (staging `https://api.roboflow.one`).

## Commands

```bash
npm run dev        # Vite dev server for index.html and examples/
npm test           # vitest, runs in Node
npm run typecheck  # tsc over src/ and examples/
npm run build      # typecheck, then dist/index.js (UMD), dist/index.mjs and .d.ts files
```

## Layout

- `src/api.ts`: the operations (`StreamingRequest`), their responses, the `Connector` interface,
  `StreamingApi` (the v1 REST client, one method per operation) and `StreamingApiError`.
- `src/connectors.ts`: `withApiKey` (a `StreamingApi` in the browser, demos only) and
  `withProxyUrl` (POSTs each request as JSON to the caller's backend).
- `src/proxy.ts`: `createStreamingProxy`, the server side of `withProxyUrl`. It validates each
  request strictly, runs `authorize`, and strips the processor token and RTSPS URL from watch
  grants.
- `src/results.ts`: `followResults`, the results-feed loop.
- `src/webrtc.ts`: WHIP publishing and WHEP playback, nothing else.
- `src/stream.ts`: `startStream`, `attachStream` and the `CloudStream` lifecycle.
- `src/streams.ts`: camera helpers.
- `src/index.ts`: everything is exported from the package root.

## Rules that matter

- **Results loop** (`results.ts`): subscribe; `ended` follows `successorJobId` (fresh cursor) or
  ends the stream; `retryAfterSeconds` waits; a feed connects to `eventsUrl` with
  `access_token=<accessToken>` and `after=<last seq>`, resetting the cursor when the execution
  generation changes. Subscribe again after every `end`, close or refused upgrade, at least 1 s
  apart, backing off refusals to 30 s. Subscribe errors: network, 408, 429 and 5xx retry after
  2 s; anything else fails the stream.
- **Ownership** (`stream.ts`): `startStream` owns its job and, for a `MediaStream`, its temporary
  session. `stop()` cancels the owned job, stops the owned session and is idempotent. An attached
  stream never cancels. `pagehide` stops owned previews with `keepalive`; deployments keep running.
  A failure cancels an owned preview but never a deployment. A failed cancel is sent again by the
  next `stop()`. Cleanup runs before `onEnd`/`onError`, so a throwing callback leaves nothing
  behind.
- **Leases**: temporary previews `hold-preview` every 30 s from creation (`held: false` ends the
  loop for that job); previews on registered sources and any played video renew `watch` every
  30 s while the job runs. Leases move to a successor job. A lease a preview lives on that is
  refused for good fails the stream; a refused video output only rejects `remoteStream`.
- **Requests** time out after 15 s, so a hung call never stalls a renewal.
- **WebRTC**: no ICE servers (the relay answers with ICE-TCP host candidates), ICE gathering
  capped at 1 s, H.264 preferred, one WHIP POST per grant with `redirect: "error"` and a
  same-origin `Location` that is DELETEd on close. A lost publisher fails the stream; the SDK never
  allocates a replacement session behind the caller's back. WHEP reconnects on failure, mute or
  stalled packets and swaps the new track into the same `MediaStream`.
- **Secrets**: never log or put in an error message `whipUrl`, `whepUrl`, `rtspsUrl`,
  `accessToken` or `processorAccessToken`.
- **Idempotency**: one `crypto.randomUUID()` per logical start, reused only to retry that request.

## Tests

Tests cover decisions, not plumbing: the results loop (`results.test.ts`, with an injected
WebSocket and fake timers), proxy validation and stripping (`proxy.test.ts`), error parsing and
retry classification (`api.test.ts`), and stream ownership (`stream.test.ts`). Stub `fetch` or pass
a fake `Connector`; WebRTC itself is verified in a real browser with the examples.
