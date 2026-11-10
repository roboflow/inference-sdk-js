# @roboflow/inference-sdk

Run Roboflow Workflows on live video from the browser with Roboflow Cloud Streaming. Publish a
camera, or use one registered in your workspace, and get every frame's Workflow results and the
annotated video.

## Install

```bash
npm install @roboflow/inference-sdk
```

## Quick start

```typescript
import { connectors, startStream, streams } from "@roboflow/inference-sdk";

const camera = await streams.useCamera({ video: { facingMode: "environment" }, audio: false });

const stream = await startStream({
  connector: connectors.withApiKey("YOUR_API_KEY"), // demos only
  source: camera,
  workflow: "your-workflow-id",
  onResult: (result) => console.log(result.outputs)
});

video.srcObject = await stream.remoteStream();

// when done
await stream.stop();
streams.stopStream(camera);
```

> **Security:** `connectors.withApiKey` puts your API key in the page, where anyone can read it,
> and logs a warning saying so. Use it for local demos only. In production, proxy through your
> server (below).

For a `MediaStream` source the SDK allocates a temporary source, publishes the video into it over
WebRTC (WHIP), starts the Workflow on it as a preview job and reads the job's results. Opening the
camera is up to you; `streams.useCamera` is a small helper.

`workflow` is a saved Workflow's id or an inline Workflow specification object.

## Production: proxy through your server

The browser sends each request to your endpoint, and your server runs it with the API key it
keeps.

```typescript
// browser
const connector = connectors.withProxyUrl("/api/streaming", {
  headers: { Authorization: `Bearer ${yourSessionToken}` }
});
```

```typescript
// server: Node 18+ or an edge runtime, no dependencies
import { createStreamingProxy } from "@roboflow/inference-sdk";

const handle = createStreamingProxy({
  apiKey: process.env.ROBOFLOW_API_KEY!,
  // per-request policy, for example: browsers may not start deployments
  authorize: (request) => request.operation !== "startJob" || request.job.purpose !== "deployment"
});

app.post("/api/streaming", express.json(), async (req, res) => {
  // check who is asking here
  const { status, body } = await handle(req.body);
  res.status(status).json(body);
});
```

`handle(body)` takes the parsed JSON body and resolves to the status and body to answer with:

- Only the SDK's operations, with exactly the fields the SDK sends, are run. Anything else
  answers `400`; a request `authorize` refuses answers `403`.
- Roboflow's refusals come back with their status as `{ "error": "<message>" }`.
- Watch grants come back without the processor token and RTSPS URL.

**Without `authorize`, anyone who can reach the endpoint can use every source and job in your
workspace with your key:** start jobs (which bill), cancel them, and watch their video. Check who
is asking, and which sources, jobs and Workflows they may use.

Each request is a `StreamingRequest`, `{ operation, ...fields }`:

| `operation`        | Fields                              | Cloud Streaming v1 route                           |
| ------------------ | ----------------------------------- | -------------------------------------------------- |
| `listSources`      |                                     | `GET /:workspace/video-sources/v1`                 |
| `createSession`    | `name?`, `idempotencyKey`           | `POST /:workspace/video-sources/v1/temporary`      |
| `startJob`         | `sourceId`, `idempotencyKey`, `job` | `POST /:workspace/video-sources/v1/:sourceId/jobs` |
| `getJob`           | `jobId`                             | `GET /:workspace/video-jobs/v1/:jobId`             |
| `holdPreview`      | `jobId`                             | `POST .../video-jobs/v1/:jobId/hold-preview`       |
| `watch`            | `jobId`, `output?`                  | `POST .../video-jobs/v1/:jobId/watch`              |
| `subscribeResults` | `jobId`                             | `POST .../video-jobs/v1/:jobId/results/subscribe`  |
| `cancelJob`        | `jobId`                             | `POST .../video-jobs/v1/:jobId/cancel`             |
| `stopSession`      | `sourceId`                          | `POST .../video-sources/v1/:sourceId/stop-session` |

`job` carries `workflowUrl` or `workflowSpecification`, and `purpose`, which is required because
the API would make a job without one a deployment. It may also carry `workflowParameters`,
`imageOutput`, `maxFps`, `processorSize` and `tier`.

`createStreamingProxy` and `connectors.withApiKey` both take `workspace` (looked up from the key
when omitted) and `apiUrl` (`https://api.roboflow.com` by default; staging is
`https://api.roboflow.one`). [`examples/proxy-server.mjs`](examples/proxy-server.mjs) is a
runnable `node:http` version.

Use a workspace API key, not a folder- or device-bound one. Starting jobs needs `workflow:read`
and `model:infer`, watching and cancelling `video-inference-job:create`, and reading results
`video-inference-job:read`.

## Registered sources and attaching

A string `source` is the id of a source registered in your workspace: a Connector camera, an
RTSP camera, an RTMP source and so on.

```typescript
const { sources } = await connector.request({ operation: "listSources" });

const stream = await startStream({
  connector,
  source: sources[0].id,
  workflow: "your-workflow-id",
  purpose: "deployment", // default "preview"
  onResult
});
console.log(stream.jobId);
```

`attachStream` follows a job that already runs, for example a deployment started elsewhere:

```typescript
const stream = await attachStream({ connector, jobId, onResult });
```

An attached stream reads results and plays video but does not own the job: its `stop()` only
releases this browser's connections.

## `startStream` options

| Option          | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `connector`     | `connectors.withProxyUrl(...)` or `connectors.withApiKey(...)`           |
| `source`        | A `MediaStream` to publish, or a registered source id                    |
| `workflow`      | A saved Workflow id or an inline specification                           |
| `parameters`    | Values for the Workflow's declared inputs                                |
| `imageOutput`   | The image output the video shows by default                              |
| `maxFps`        | Processing rate limit                                                    |
| `processorSize` | `gpu-s-v1`, `gpu-m-v1`, `gpu-l-v1` or `cpu-standard-v1`                  |
| `purpose`       | `preview` (default) or `deployment` (registered sources only)            |
| `onResult`      | Each processed frame's results                                           |
| `onGap`         | Results that could not be delivered                                      |
| `onEnd`         | The job ended by itself; `reason` is `completed`, `cancelled` or `error` |
| `onError`       | The stream failed                                                        |

## Results

Results flow as soon as the job runs, whether or not you play the video.

```typescript
onResult: ({ seq, frameId, timestamp, latencyMs, outputs, executionGeneration }) => {};
onGap: ({ fromSeq, toSeq }) => {};
```

- `outputs` holds the Workflow's outputs. Image outputs arrive as
  `{ "type": "image_ref", "output": "<name>" }`; the pixels are in the video.
- `timestamp` is when the result was published (ISO 8601, UTC), not when the frame was captured.
- `seq` counts results within one execution and starts over when the job runs again on another
  processor; `executionGeneration` tells executions apart.
- `onGap` reports results that were not delivered, for example while this browser fell behind or
  reconnected. Gaps are never hidden.

The SDK reconnects on its own, resumes after the last result it delivered, and follows the job
when it continues under a new id (`stream.jobId` changes with it).

## Video

```typescript
video.srcObject = await stream.remoteStream(); // the job's default image output
await stream.remoteStream("other_output"); // switches the output, same MediaStream
```

`remoteStream` resolves once the job runs and its output arrives, which takes as long as the job
takes to start. From the first call until the stream stops, the SDK renews the watch every 30 s
and reconnects when the video drops or stalls. A job publishes one image output at a time, so
another `output` switches it for everyone watching that job. The promise rejects when Cloud
Streaming refuses the output (unknown, or not an image) or the stream ends first.

`stream.localStream()` is the `MediaStream` the stream publishes, or `null`.

## Stopping, lifecycle and billing

Processing is billed while a job runs.

- **Previews** end when you call `stop()`, when the page closes (the SDK stops them on `pagehide`
  with `keepalive` requests), when nothing renews them for a few minutes, and after one hour at
  most.
- **Deployments** (registered sources only) keep running, and billing, after the page closes,
  until `stop()` or a cancel from the Roboflow app or API.

`stop()` cancels the job the stream started, stops the session it allocated and closes its
connections. Calling it again is safe. It rejects when the cancel fails after its retries, so you
know a deployment may still run; calling it again sends the cancel again.

A stream ends with exactly one of these, and no callback runs after it:

- `onEnd({ reason })`: the job ended by itself (`completed`, `cancelled` elsewhere, or `error`).
- `onError(error)`: the stream failed, for example the published camera's connection dropped,
  which ends its session (the SDK does not open a new one behind your back), Cloud Streaming
  refused a lease the preview lives on, or the page was left. A failed preview is cancelled; a
  failed deployment keeps running.
- Your `stop()`.

## Errors

Every refusal, from the Cloud Streaming API, your proxy or the video relay, is a
`StreamingApiError` with the HTTP `status` and the API's `message`:

```typescript
import { StreamingApiError } from "@roboflow/inference-sdk";

try {
  await startStream(options);
} catch (error) {
  if (error instanceof StreamingApiError && error.status === 409) {
    // no browser session available
  }
}
```

- Requests time out after 15 s. Starting and cancelling retry lost requests, timeouts, `408`,
  `429` and `5xx` up to three times, starts with the same idempotency key; other refusals fail at
  once.
- `409` when publishing a `MediaStream` means no browser session is available: four are already
  starting in the workspace, or the region does not offer browser streaming (EU does not).
- The camera's video reaches the relay over WebRTC on TCP port 8189; on a network that blocks it,
  `startStream` fails with a connection error.

## Server-side REST client

`StreamingApi` is the client `connectors.withApiKey` and `createStreamingProxy` use, with one
method per operation. Keep it on a server.

```typescript
import { StreamingApi } from "@roboflow/inference-sdk";

const api = new StreamingApi({ apiKey: process.env.ROBOFLOW_API_KEY! });
const { job } = await api.getJob({ jobId });
const { rtspsUrl } = await api.watch({ jobId }); // the full grant, server side only
```

## Examples

```bash
npm install
npm run dev # http://localhost:5173
```

- [`examples/webcam`](examples/webcam.ts): publish the camera, play the annotated video, show
  results.
- [`examples/existing-source`](examples/existing-source.ts): run a Workflow on a registered
  source as a preview or a deployment, or attach to a job.
- [`examples/proxy-server.mjs`](examples/proxy-server.mjs): the proxy. Run
  `npm run build && ROBOFLOW_API_KEY=... node examples/proxy-server.mjs`; `npm run dev` forwards
  `/api` to it, so the pages use it when their API key field is empty.

## Migrating from 0.x

0.x opened a WebRTC connection from each browser to an inference worker and received results
over it. This release streams through Cloud Streaming jobs instead, so the transport, the
connectors and the options changed.

| 0.x                                                                                                                                                            | Now                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `webrtc.useStream({ source, connector, wrtcParams, onData })`                                                                                                  | `startStream({ source, connector, workflow, onResult })`                                     |
| `wrtcParams.workflowSpec`, or `workspaceName` + `workflowId`                                                                                                   | `workflow`: a specification or a saved Workflow id                                           |
| `wrtcParams.workflowsParameters`                                                                                                                               | `parameters`                                                                                 |
| `wrtcParams.streamOutputNames`                                                                                                                                 | `imageOutput`, or `remoteStream(output)`                                                     |
| `wrtcParams.dataOutputNames`, `reconfigureOutputs()`                                                                                                           | Removed: every result carries all outputs, and `remoteStream(output)` switches the video     |
| `onData({ serialized_output_data, video_metadata })`                                                                                                           | `onResult({ outputs, frameId, timestamp, ... })`                                             |
| `connection.cleanup()`                                                                                                                                         | `stream.stop()`                                                                              |
| `connectors.withApiKey(key, { serverUrl })`                                                                                                                    | `connectors.withApiKey(key, { workspace, apiUrl })`                                          |
| `connectors.withProxyUrl(url, { turnConfigUrl })` and your own worker proxy                                                                                    | `connectors.withProxyUrl(url, { headers })` and `createStreamingProxy` on your server        |
| `InferenceHTTPClient`                                                                                                                                          | `StreamingApi`                                                                               |
| `WorkflowError` (`statusCode`, `errorData`)                                                                                                                    | `StreamingApiError` (`status`, `message`)                                                    |
| `webrtc.useRtspStream({ rtspUrl })`                                                                                                                            | Register the camera in Roboflow, then `startStream({ source: sourceId })`                    |
| `webrtc.useVideoFile({ file })`                                                                                                                                | Play it in a `<video>` and pass `video.captureStream()` as `source` (real time)              |
| `iceServers` and TURN config                                                                                                                                   | Removed: the relay is reached over TCP port 8189                                             |
| `hooks`, `requestedPlan`, `requestedRegion`, `processingTimeout`, `realtimeProcessing`, `threadPoolWorkers`, `extraPayload`, `disableInputStreamDownscaling` | Removed: Cloud Streaming places and sizes jobs; `processorSize` and `maxFps` are the controls |
| `import { useCamera } from "@roboflow/inference-sdk/streams"`                                                                                                  | `import { streams } from "@roboflow/inference-sdk"`                                          |

## License

See the repository for license information.
