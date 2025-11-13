# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `@roboflow/inference-sdk`, a lightweight TypeScript client library for Roboflow's hosted inference API with WebRTC streaming support. It provides real-time computer vision inference capabilities without bundling TensorFlow or local models, making it ideal for production web applications.

## Development Commands

```bash
# Start development server with hot reload
npm run dev

# Build the library (creates dist/ with UMD and ES modules)
npm run build

# Preview the production build
npm run preview

# Clean build artifacts
npm run clean
```

## Architecture

### Module Structure

The library uses a modular export pattern with three main modules:

1. **`inference-api.ts`** - Core HTTP client and connector abstractions
   - `InferenceHTTPClient` - Handles API communication with Roboflow serverless backend
   - `connectors.withApiKey()` - Direct API key connector (for demos/testing only)
   - `connectors.withProxyUrl()` - Proxy-based connector (recommended for production)
   - Exports all types: `WebRTCParams`, `Connector`, `WorkflowSpec`, etc.

2. **`webrtc.ts`** - WebRTC streaming implementation
   - `useStream()` - Main function to establish WebRTC connections for real-time inference
   - `RFWebRTCConnection` - Connection object with methods:
     - `remoteStream()` - Get processed video from Roboflow
     - `localStream()` - Get original camera stream
     - `cleanup()` - Terminate pipeline and close connection
     - `reconfigureOutputs()` - Dynamically change outputs at runtime

3. **`streams.ts`** - Camera utilities
   - `useCamera()` - Access device camera with fallback handling
   - `stopStream()` - Stop media streams and release camera

### Entry Point Pattern

`index.ts` re-exports everything from `inference-api` at the root level, while exporting `webrtc` and `streams` as namespace objects. This allows for flexible import patterns:

```typescript
// Import connectors and types from root
import { connectors, InferenceHTTPClient } from '@roboflow/inference-sdk';

// Import from namespaced modules
import { useStream } from '@roboflow/inference-sdk/webrtc';
import { useCamera } from '@roboflow/inference-sdk/streams';
```

### WebRTC Connection Flow

The WebRTC connection establishment follows this sequence:

1. **Peer Connection Setup** (`preparePeerConnection`):
   - Creates RTCPeerConnection with STUN server
   - Adds transceiver for receiving remote video (MUST be before local tracks)
   - Adds local camera tracks with `contentHint: "detail"` optimization
   - Creates bidirectional data channel for control messages
   - Waits for ICE gathering with srflx candidate validation

2. **SDP Exchange**:
   - Creates local offer and sets it as local description
   - Calls `connector.connectWrtc()` to exchange offer/answer with Roboflow
   - Sets remote description from server answer
   - Waits for connection state to become "connected" (30s timeout)

3. **Quality Optimization**:
   - By default, disables input stream downscaling via `setParameters({ scaleResolutionDownBy: 1 })`
   - Can be disabled via `options.disableInputStreamDownscaling = false`

4. **Pipeline Management**:
   - Server returns `pipeline_id` in answer context
   - Stored for cleanup via `/inference_pipelines/{id}/terminate` endpoint

### Connector Pattern

The connector abstraction allows flexible authentication methods:

- **`withApiKey()`** - Directly embeds API key in requests. Displays security warning in browser context. Use only for demos.
- **`withProxyUrl()`** - Production-safe pattern where frontend calls backend proxy, which adds API key server-side and forwards to Roboflow.

Both implement the `Connector` interface with `connectWrtc(offer, wrtcParams)` method.

## Build Configuration

Uses Vite with the following setup:
- **Entry**: `src/index.ts`
- **Output formats**: UMD (browser global) and ES modules
- **TypeScript**: Strict mode enabled with declaration generation via `vite-plugin-dts`
- **Target**: ES2020 with DOM APIs
- **Output**: `dist/` directory with:
  - `index.js` (UMD)
  - `index.es.js` (ESM)
  - `index.d.ts` (TypeScript declarations)

## Critical Implementation Details

### WebRTC Transceiver Ordering

**IMPORTANT**: The transceiver for receiving remote video MUST be added BEFORE local tracks. This is required for proper bidirectional video flow:

```typescript
// Correct order in preparePeerConnection:
pc.addTransceiver("video", { direction: "recvonly" }); // First
localStream.getVideoTracks().forEach(track => pc.addTrack(track, localStream)); // Second
```

### ICE Gathering Validation

The `waitForIceGathering()` function validates that at least one srflx (server reflexive) candidate is gathered before proceeding. This ensures the connection can traverse NAT. If timeout occurs without srflx, an error is thrown.

### Data Channel Protocol

The `roboflow-control` data channel supports bidirectional JSON messages:
- **Outbound**: `reconfigureOutputs()` sends `{ stream_output, data_output }` to dynamically change outputs
- **Inbound**: Received in `onData` callback, typically containing inference results

### Workflow Configuration

The API supports two mutually exclusive ways to specify workflows:
1. Inline `workflowSpec` object (full workflow definition)
2. Reference via `workspaceName` + `workflowId`

The `initializeWebrtcWorker()` method validates that exactly one is provided.

## Security Considerations

- **Never use `connectors.withApiKey()` in production frontend code** - it exposes the API key in browser
- Always implement backend proxy for production deployments
- The library displays console warning when `withApiKey()` is detected in browser context
- API keys should be stored in environment variables server-side (e.g., `process.env.ROBOFLOW_API_KEY`)

## TypeScript Configuration

- **Strict mode enabled**: All strict type checks are enforced
- **No unused locals/parameters**: Enforced at compile time
- **Module resolution**: Uses bundler mode for optimal tree-shaking
- **Isolated modules**: Each file can be transpiled independently
