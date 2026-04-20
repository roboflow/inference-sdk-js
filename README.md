# @roboflow/inference-sdk

Lightweight JS client for Roboflow's hosted inference API with WebRTC streaming support for real-time computer vision in the browser.

## Installation

```bash
npm install @roboflow/inference-sdk
```

## Quick Example

```typescript
import { useStream, connectors } from '@roboflow/inference-sdk';
import { useCamera } from '@roboflow/inference-sdk/streams';

const stream = await useCamera({ video: { facingMode: "environment" } });
const connection = await useStream({
  source: stream,
  connector: connectors.withProxyUrl('/api/init-webrtc'), // Use backend proxy
  wrtcParams: { workflowSpec: { /* ... */ } },
  onData: (data) => console.log("Inference results:", data)
});

const videoElement.srcObject = await connection.remoteStream();
```

See the [sample app](https://github.com/roboflow/inferenceSampleApp) for a complete working example.

## Error Handling

Both `connectors.withApiKey()` and `connectors.withProxyUrl()` throw a `WorkflowError` when the backend returns a structured error response (e.g. invalid workflow spec, missing model, block execution failure). For other failures (network errors, non-JSON responses) a plain `Error` is thrown. `WorkflowError` extends `Error`, so existing `catch` blocks keep working.

```typescript
import { useStream, connectors, WorkflowError } from '@roboflow/inference-sdk';

try {
  const connection = await useStream({
    source: stream,
    connector: connectors.withProxyUrl('/api/init-webrtc'),
    wrtcParams: { workflowSpec: { /* ... */ } },
    onData: (data) => console.log(data),
  });
} catch (err) {
  if (err instanceof WorkflowError) {
    // err.statusCode: HTTP status from the backend (e.g. 400)
    // err.errorData: { message, error_type, context, inner_error_type,
    //                  inner_error_message, blocks_errors }
    console.error(err.errorData.error_type, err.errorData.message);
    for (const block of err.errorData.blocks_errors ?? []) {
      console.error(`  block ${block.block_id}: ${block.property_details}`);
    }
  } else {
    console.error('Transport error:', err);
  }
}
```

For this to work with `withProxyUrl()`, your backend proxy must forward Roboflow's
error status and JSON body. The recommended pattern:

```typescript
try {
  const answer = await client.initializeWebrtcWorker({ /* ... */ });
  res.json(answer);
} catch (err) {
  if (err instanceof WorkflowError) {
    res.status(err.statusCode).json(err.errorData);
  } else {
    res.status(500).json({ message: err.message ?? 'Unknown error' });
  }
}
```

## Security Warning

**Never expose your API key in frontend code.** Always use a backend proxy for production applications. The sample app demonstrates the recommended proxy pattern.

## Get Started

For a complete working example with backend proxy setup, see:
**[github.com/roboflow/inferenceSampleApp](https://github.com/roboflow/inferenceSampleApp)**

## Resources

- [Roboflow Documentation](https://docs.roboflow.com/)
- [API Authentication Guide](https://docs.roboflow.com/api-reference/authentication)
- [Workflows Documentation](https://docs.roboflow.com/workflows)

## License

See the main repository for license information.
