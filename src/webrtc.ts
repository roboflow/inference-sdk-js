
import { InferenceHTTPClient, Connector, WebRTCParams, RTCIceServerConfig } from "./inference-api";
import { stopStream } from "./streams";

/**
 * Binary protocol header size (frame_id + chunk_index + total_chunks)
 * Each field is 4 bytes uint32 little-endian
 */
const HEADER_SIZE = 12;

/**
 * Reassembles chunked binary messages from the datachannel
 */
export class ChunkReassembler {
  private pendingFrames: Map<number, {
    chunks: Map<number, Uint8Array>;
    totalChunks: number;
  }> = new Map();

  /**
   * Process an incoming chunk and return the complete message if all chunks received
   */
  processChunk(frameId: number, chunkIndex: number, totalChunks: number, payload: Uint8Array): Uint8Array | null {
    // Single chunk message - return immediately
    if (totalChunks === 1) {
      return payload;
    }

    // Multi-chunk message - accumulate
    if (!this.pendingFrames.has(frameId)) {
      this.pendingFrames.set(frameId, {
        chunks: new Map(),
        totalChunks
      });
    }

    const frame = this.pendingFrames.get(frameId)!;
    frame.chunks.set(chunkIndex, payload);

    // Check if all chunks received
    if (frame.chunks.size === totalChunks) {
      // Reassemble in order
      const totalLength = Array.from(frame.chunks.values()).reduce((sum, chunk) => sum + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;

      for (let i = 0; i < totalChunks; i++) {
        const chunk = frame.chunks.get(i)!;
        result.set(chunk, offset);
        offset += chunk.length;
      }

      this.pendingFrames.delete(frameId);
      return result;
    }

    return null;
  }

  /**
   * Clear all pending frames (for cleanup)
   */
  clear(): void {
    this.pendingFrames.clear();
  }
}

/**
 * Parse the binary header from a datachannel message
 */
export function parseBinaryHeader(buffer: ArrayBuffer): { frameId: number; chunkIndex: number; totalChunks: number; payload: Uint8Array } {
  const view = new DataView(buffer);
  const frameId = view.getUint32(0, true);      // little-endian
  const chunkIndex = view.getUint32(4, true);   // little-endian
  const totalChunks = view.getUint32(8, true);  // little-endian
  const payload = new Uint8Array(buffer, HEADER_SIZE);

  return { frameId, chunkIndex, totalChunks, payload };
}

export interface UseStreamOptions {
  disableInputStreamDownscaling?: boolean;
}

export interface UseStreamParams {
  source: MediaStream;
  connector: Connector;
  wrtcParams: WebRTCParams;
  onData?: (data: any) => void;
  options?: UseStreamOptions;
}

async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 6000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;

  const startTime = Date.now();
  let hasSrflx = false;

  // Track if we get a good candidate (srflx = public IP via STUN)
  const candidateHandler = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate && event.candidate.type === "srflx") {
      hasSrflx = true;
    }
  };
  pc.addEventListener("icecandidate", candidateHandler);

  try {
    await Promise.race([
      new Promise<void>(resolve => {
        const check = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", check);
      }),
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (!hasSrflx) {
            console.error("[ICE] timeout with NO srflx candidate! Connection may fail.");
            reject(new Error("ICE gathering timeout without srflx candidate"));
          } else {
            resolve();
          }
        }, timeoutMs);
      })
    ]);
  } finally {
    pc.removeEventListener("icecandidate", candidateHandler);
  }
}

function setupRemoteStreamListener(pc: RTCPeerConnection): Promise<MediaStream> {
  return new Promise((resolve) => {
    pc.addEventListener("track", (event: RTCTrackEvent) => {
      if (event.streams && event.streams[0]) {
        resolve(event.streams[0]);
      }
    });
  });
}

const DEFAULT_ICE_SERVERS: RTCIceServerConfig[] = [
  { urls: ["stun:stun.l.google.com:19302"] }
];

async function preparePeerConnection(
  localStream: MediaStream,
  customIceServers?: RTCIceServerConfig[]
): Promise<{
  pc: RTCPeerConnection;
  offer: RTCSessionDescriptionInit;
  remoteStreamPromise: Promise<MediaStream>;
  dataChannel: RTCDataChannel;
}> {
  const iceServers = customIceServers ?? DEFAULT_ICE_SERVERS;

  const pc = new RTCPeerConnection({
    iceServers: iceServers as RTCIceServer[]
  });

  // Add transceiver for receiving remote video (BEFORE adding tracks - order matters!)
  try {
    pc.addTransceiver("video", { direction: "recvonly" });
  } catch (err) {
    console.warn("[RFWebRTC] Could not add transceiver:", err);
  }

  // Add local tracks
  localStream.getVideoTracks().forEach(track => {
    try {
      // @ts-ignore - contentHint is not in all TypeScript definitions
      track.contentHint = "detail";
    } catch (e) {
      // Ignore if contentHint not supported
    }
    pc.addTrack(track, localStream);
  });

  // Setup remote stream listener
  const remoteStreamPromise = setupRemoteStreamListener(pc);

  const dataChannel = pc.createDataChannel("roboflow-control", {
    ordered: true
  });

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering
  await waitForIceGathering(pc);

  return {
    pc,
    offer: pc.localDescription!,
    remoteStreamPromise,
    dataChannel
  };
}

/**
 * Disable input stream downscaling
 * @private
 */
async function disableInputStreamDownscaling(pc: RTCPeerConnection): Promise<void> {
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (!sender) return;

  const params = sender.getParameters();
  params.encodings = params.encodings || [{}];
  params.encodings[0].scaleResolutionDownBy = 1;

  try {
    await sender.setParameters(params);
  } catch (err) {
    console.warn("[RFWebRTC] Failed to set encoding parameters:", err);
  }
}

/**
 * WebRTC Connection object
 *
 * Represents an active WebRTC connection to Roboflow for streaming inference.
 */
export class RFWebRTCConnection {
  private pc: RTCPeerConnection;
  private _localStream: MediaStream;
  private remoteStreamPromise: Promise<MediaStream>;
  private pipelineId: string | null;
  private apiKey: string | null;
  private dataChannel: RTCDataChannel;
  private reassembler: ChunkReassembler;

  /** @private */
  constructor(
    pc: RTCPeerConnection,
    localStream: MediaStream,
    remoteStreamPromise: Promise<MediaStream>,
    pipelineId: string | null,
    apiKey: string | null,
    dataChannel: RTCDataChannel,
    onData?: (data: any) => void
  ) {
    this.pc = pc;
    this._localStream = localStream;
    this.remoteStreamPromise = remoteStreamPromise;
    this.pipelineId = pipelineId;
    this.apiKey = apiKey;
    this.dataChannel = dataChannel;
    this.reassembler = new ChunkReassembler();

    // Set binary mode for datachannel
    this.dataChannel.binaryType = "arraybuffer";

    // Setup data channel event listeners
    if (onData) {
      this.dataChannel.addEventListener("open", () => {
        // console.log("[RFWebRTC] Data channel opened");
      });

      this.dataChannel.addEventListener("message", (messageEvent: MessageEvent) => {
        try {
          // Handle binary protocol with chunking
          if (messageEvent.data instanceof ArrayBuffer) {
            const { frameId, chunkIndex, totalChunks, payload } = parseBinaryHeader(messageEvent.data);
            const completePayload = this.reassembler.processChunk(frameId, chunkIndex, totalChunks, payload);

            if (completePayload) {
              // Decode UTF-8 JSON payload
              const decoder = new TextDecoder("utf-8");
              const jsonString = decoder.decode(completePayload);
              const data = JSON.parse(jsonString);
              onData(data);
            }
          } else {
            // Fallback for string messages (shouldn't happen with new protocol)
            const data = JSON.parse(messageEvent.data);
            onData(data);
          }
        } catch (err) {
          console.error("[RFWebRTC] Failed to parse data channel message:", err);
        }
      });

      this.dataChannel.addEventListener("error", (error) => {
        console.error("[RFWebRTC] Data channel error:", error);
      });

      this.dataChannel.addEventListener("close", () => {
        // console.log("[RFWebRTC] Data channel closed");
        this.reassembler.clear();
      });
    }
  }

  /**
   * Get the remote stream (processed video from Roboflow)
   *
   * @returns Promise resolving to the remote MediaStream
   *
   * @example
   * ```typescript
   * const conn = await useStream({ ... });
   * const remoteStream = await conn.remoteStream();
   * videoElement.srcObject = remoteStream;
   * ```
   */
  async remoteStream(): Promise<MediaStream> {
    return await this.remoteStreamPromise;
  }

  /**
   * Get the local stream (original camera)
   *
   * @returns The local MediaStream
   *
   * @example
   * ```typescript
   * const conn = await useStream({ ... });
   * const localStream = conn.localStream();
   * videoElement.srcObject = localStream;
   * ```
   */
  localStream(): MediaStream {
    return this._localStream;
  }

  /**
   * Cleanup and close connection
   *
   * Terminates the pipeline on Roboflow, closes the peer connection,
   * and stops the local media stream.
   *
   * @returns Promise that resolves when cleanup is complete
   *
   * @example
   * ```typescript
   * const conn = await useStream({ ... });
   * // ... use connection ...
   * await conn.cleanup(); // Clean up when done
   * ```
   */
  async cleanup(): Promise<void> {
    // Clear pending chunks
    this.reassembler.clear();

    // Terminate pipeline
    if (this.pipelineId && this.apiKey) {
      const client = InferenceHTTPClient.init({ apiKey: this.apiKey });
      await client.terminatePipeline({ pipelineId: this.pipelineId });
    }

    // Close peer connection
    if (this.pc && this.pc.connectionState !== "closed") {
      this.pc.close();
    }

    // Stop local stream
    stopStream(this._localStream);
  }

  /**
   * Reconfigure pipeline outputs at runtime
   *
   * Dynamically change stream and data outputs without restarting the connection.
   * Set a field to `null` to leave it unchanged, or to `null` value to enable all outputs,
   * or to `[]` to disable/auto-detect.
   *
   * @param config - Output configuration
   * @param config.streamOutput - Stream output names (null = unchanged, [] = auto-detect, ["name"] = specific output)
   * @param config.dataOutput - Data output names (null = unchanged, [] = disable, ["name"] = specific outputs, null value = all outputs)
   *
   * @example
   * ```typescript
   * // Change to different stream output
   * connection.reconfigureOutputs({
   *   streamOutput: ["annotated_image"],
   *   dataOutput: null  // unchanged
   * });
   *
   * // Enable all data outputs
   * connection.reconfigureOutputs({
   *   streamOutput: null,  // unchanged
   *   dataOutput: null     // null value = all outputs
   * });
   *
   * // Disable all data outputs
   * connection.reconfigureOutputs({
   *   streamOutput: null,  // unchanged
   *   dataOutput: []       // empty array = disable
   * });
   * ```
   */
  reconfigureOutputs(config: { streamOutput?: string[] | null; dataOutput?: string[] | null }): void {
    const message: any = {};

    if (config.streamOutput !== undefined) {
      message.stream_output = config.streamOutput;
    }

    if (config.dataOutput !== undefined) {
      message.data_output = config.dataOutput;
    }

    this.sendData(message);
  }

  /**
   * Send data through the data channel
   * @private
   */
  private sendData(data: any): void {
    if (this.dataChannel.readyState !== "open") {
      console.warn("[RFWebRTC] Data channel is not open. Current state:", this.dataChannel.readyState);
      return;
    }

    try {
      const message = typeof data === "string" ? data : JSON.stringify(data);
      this.dataChannel.send(message);
    } catch (err) {
      console.error("[RFWebRTC] Failed to send data:", err);
    }
  }
}

/**
 * Main function to establish WebRTC streaming connection
 *
 * Creates a WebRTC connection to Roboflow for real-time inference on video streams.
 *
 * @param params - Connection parameters
 * @returns Promise resolving to RFWebRTCConnection
 *
 * @example
 * ```typescript
 * import { useStream } from 'inferencejs/webrtc';
 * import { connectors } from 'inferencejs/api';
 * import { useCamera } from 'inferencejs/streams';
 *
 * const connector = connectors.withApiKey("your-api-key");
 * const stream = await useCamera({ video: { facingMode: { ideal: "environment" } } });
 * const conn = await useStream({
 *   source: stream,
 *   connector,
 *   wrtcParams: {
 *     workflowSpec: {
 *       // Your workflow specification
 *     },
 *     imageInputName: "image",
 *     streamOutputNames: ["output"],
 *     dataOutputNames: ["predictions"]
 *   },
 *   onData: (data) => {
 *     console.log("Inference results:", data);
 *   }
 * });
 *
 * const remoteStream = await conn.remoteStream();
 * videoElement.srcObject = remoteStream;
 * ```
 */
export async function useStream({
  source,
  connector,
  wrtcParams,
  onData,
  options = {}
}: UseStreamParams): Promise<RFWebRTCConnection> {
  // Validate connector
  if (!connector || typeof connector.connectWrtc !== "function") {
    throw new Error("connector must have a connectWrtc method");
  }

  // Step 1: Use provided media stream
  const localStream = source;

  // Step 2: Prepare peer connection and create offer (with custom ICE servers if provided)
  const { pc, offer, remoteStreamPromise, dataChannel } = await preparePeerConnection(
    localStream,
    wrtcParams.iceServers
  );

  // Step 3: Call connector.connectWrtc to exchange SDP and get answer
  const answer = await connector.connectWrtc(
    { sdp: offer.sdp!, type: offer.type! },
    wrtcParams
  );

  // API returns sdp and type at root level
  const sdpAnswer = { sdp: answer.sdp, type: answer.type };

  if (!sdpAnswer?.sdp || !sdpAnswer?.type) {
    console.error("[RFWebRTC] Invalid answer from server:", answer);
    throw new Error("connector.connectWrtc must return answer with sdp and type");
  }

  const pipelineId = answer?.context?.pipeline_id || null;

  // Step 4: Set remote description
  await pc.setRemoteDescription(sdpAnswer);

  // Step 5: Wait for connection to establish
  await new Promise<void>((resolve, reject) => {
    const checkState = () => {
      if (pc.connectionState === "connected") {
        pc.removeEventListener("connectionstatechange", checkState);
        resolve();
      } else if (pc.connectionState === "failed") {
        pc.removeEventListener("connectionstatechange", checkState);
        reject(new Error("WebRTC connection failed"));
      }
    };

    pc.addEventListener("connectionstatechange", checkState);
    checkState(); // Check immediately in case already connected

    // Timeout after 30 seconds
    setTimeout(() => {
      pc.removeEventListener("connectionstatechange", checkState);
      reject(new Error("WebRTC connection timeout after 30s"));
    }, 30000);
  });

  // Step 6: Optimize quality (disable downsampling by default)
  const shouldDisableDownscaling = options.disableInputStreamDownscaling !== false; // Default to true
  if (shouldDisableDownscaling) {
    await disableInputStreamDownscaling(pc);
  }

  // Get apiKey from connector if available (for cleanup)
  const apiKey = connector._apiKey || null;

  const connection = new RFWebRTCConnection(pc, localStream, remoteStreamPromise, pipelineId, apiKey, dataChannel, onData);

  // Return connection object
  return connection;
}
