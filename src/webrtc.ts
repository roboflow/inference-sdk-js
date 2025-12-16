
import { InferenceHTTPClient, Connector, WebRTCParams, RTCIceServerConfig } from "./inference-api";
import { stopStream } from "./streams";
import { WebRTCOutputData } from "./webrtc-types";
import { FileUploader } from "./video-upload";

// Re-export shared types
export type { WebRTCVideoMetadata, WebRTCOutputData } from "./webrtc-types";

// Re-export FileUploader from video-upload
export { FileUploader } from "./video-upload";

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
  onData?: (data: WebRTCOutputData) => void;
  options?: UseStreamOptions;
}

async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 6000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;

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
  localStream?: MediaStream,
  file?: File,
  customIceServers?: RTCIceServerConfig[]
): Promise<{
  pc: RTCPeerConnection;
  offer: RTCSessionDescriptionInit;
  remoteStreamPromise: Promise<MediaStream>;
  dataChannel: RTCDataChannel;
  uploadChannel?: RTCDataChannel;
}> {
  if (!localStream && !file || (localStream && file)) {
    throw new Error("Either localStream or file must be provided, but not both");
  }
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

  if (localStream) {
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
  }

  // Setup remote stream listener
  const remoteStreamPromise = setupRemoteStreamListener(pc);

  // Create control datachannel (named "inference" to match Python SDK)
  const dataChannel = pc.createDataChannel("inference", {
    ordered: true
  });

  // Create upload datachannel for file uploads
  let uploadChannel: RTCDataChannel | undefined;
  if (file) {
    uploadChannel = pc.createDataChannel("video_upload");
  }

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering
  await waitForIceGathering(pc);

  return {
    pc,
    offer: pc.localDescription!,
    remoteStreamPromise,
    dataChannel,
    uploadChannel
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
 * Helper to wait for datachannel to open
 */
function waitForChannelOpen(channel: RTCDataChannel, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (channel.readyState === "open") {
      resolve();
      return;
    }

    const openHandler = () => {
      channel.removeEventListener("open", openHandler);
      channel.removeEventListener("error", errorHandler);
      clearTimeout(timeout);
      resolve();
    };

    const errorHandler = () => {
      channel.removeEventListener("open", openHandler);
      channel.removeEventListener("error", errorHandler);
      clearTimeout(timeout);
      reject(new Error("Datachannel error"));
    };

    const timeout = setTimeout(() => {
      channel.removeEventListener("open", openHandler);
      channel.removeEventListener("error", errorHandler);
      reject(new Error("Datachannel open timeout"));
    }, timeoutMs);

    channel.addEventListener("open", openHandler);
    channel.addEventListener("error", errorHandler);
  });
}

/**
 * WebRTC Connection object
 *
 * Represents an active WebRTC connection to Roboflow for streaming inference
 * or file-based batch processing.
 */
export class RFWebRTCConnection {
  private pc: RTCPeerConnection;
  private _localStream?: MediaStream;
  private remoteStreamPromise: Promise<MediaStream>;
  private pipelineId: string | null;
  private apiKey: string | null;
  private dataChannel: RTCDataChannel;
  private reassembler: ChunkReassembler;
  private uploadChannel?: RTCDataChannel;
  private uploader?: FileUploader;
  private onComplete?: () => void;

  /** @private */
  constructor(
    pc: RTCPeerConnection,
    remoteStreamPromise: Promise<MediaStream>,
    pipelineId: string | null,
    apiKey: string | null,
    dataChannel: RTCDataChannel,
    options?: {
      localStream?: MediaStream;
      uploadChannel?: RTCDataChannel;
      onData?: (data: any) => void;
      onComplete?: () => void;
    }
  ) {
    this.pc = pc;
    this._localStream = options?.localStream;
    this.remoteStreamPromise = remoteStreamPromise;
    this.pipelineId = pipelineId;
    this.apiKey = apiKey;
    this.dataChannel = dataChannel;
    this.reassembler = new ChunkReassembler();
    this.uploadChannel = options?.uploadChannel;
    this.onComplete = options?.onComplete;

    // Set binary mode for datachannel
    this.dataChannel.binaryType = "arraybuffer";

    const onData = options?.onData;

    // Setup data channel event listeners
    if (onData) {
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
    }

    // Handle channel close - call onComplete when processing finishes
    this.dataChannel.addEventListener("close", () => {
      this.reassembler.clear();
      if (this.onComplete) {
        this.onComplete();
      }
    });
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
   * @returns The local MediaStream, or undefined if using file upload mode
   *
   * @example
   * ```typescript
   * const conn = await useStream({ ... });
   * const localStream = conn.localStream();
   * if (localStream) {
   *   videoElement.srcObject = localStream;
   * }
   * ```
   */
  localStream(): MediaStream | undefined {
    return this._localStream;
  }

  /**
   * Cleanup and close connection
   *
   * Terminates the pipeline on Roboflow, closes the peer connection,
   * and stops the local media stream (if applicable).
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
    // Cancel any ongoing upload
    if (this.uploader) {
      this.uploader.cancel();
    }

    // Clear pending chunks
    this.reassembler.clear();

    // Terminate pipeline
    if (this.pipelineId && this.apiKey) {
      try {
        const client = InferenceHTTPClient.init({ apiKey: this.apiKey });
        await client.terminatePipeline({ pipelineId: this.pipelineId });
      } catch (err) {
        console.warn("[RFWebRTC] Failed to terminate pipeline:", err);
      }
    }

    // Close peer connection
    if (this.pc && this.pc.connectionState !== "closed") {
      this.pc.close();
    }

    // Stop local stream if present
    if (this._localStream) {
      stopStream(this._localStream);
    }
  }

  /**
   * Start uploading a file through the connection
   *
   * @param file - The file to upload
   * @param onProgress - Optional callback for progress updates (bytesUploaded, totalBytes)
   * @returns Promise that resolves when upload is complete
   * @throws Error if no upload channel is available
   *
   * @example
   * ```typescript
   * await connection.startUpload(videoFile, (uploaded, total) => {
   *   console.log(`Upload progress: ${(uploaded / total * 100).toFixed(1)}%`);
   * });
   * ```
   */
  async startUpload(file: File, onProgress?: (bytesUploaded: number, totalBytes: number) => void): Promise<void> {
    if (!this.uploadChannel) {
      throw new Error("No upload channel available. This connection was not created for file uploads.");
    }

    // Wait for upload channel to open
    await waitForChannelOpen(this.uploadChannel);

    this.uploader = new FileUploader(file, this.uploadChannel);
    await this.uploader.upload(onProgress);
  }

  /**
   * Cancel any ongoing file upload
   */
  cancelUpload(): void {
    if (this.uploader) {
      this.uploader.cancel();
    }
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
 * Internal base function for establishing WebRTC connection
 * Used by both useStream and useVideoFile
 * @private
 */
interface BaseUseStreamParams {
  source: MediaStream | File;
  connector: Connector;
  wrtcParams: WebRTCParams;
  onData?: (data: WebRTCOutputData) => void;
  onComplete?: () => void;
  onFileUploadProgress?: (bytesUploaded: number, totalBytes: number) => void;
  options?: UseStreamOptions;
}

async function baseUseStream({
  source,
  connector,
  wrtcParams,
  onData,
  onComplete,
  onFileUploadProgress,
  options = {}
}: BaseUseStreamParams): Promise<RFWebRTCConnection> {
  // Validate connector
  if (!connector || typeof connector.connectWrtc !== "function") {
    throw new Error("connector must have a connectWrtc method");
  }

  const isFile = source instanceof File;
  const localStream = isFile ? undefined : source;
  const file = isFile ? source : undefined;

  // Step 1: Determine ICE servers to use
  // Priority: 1) User-provided in wrtcParams, 2) From connector.getIceServers(), 3) Defaults
  let iceServers = wrtcParams.iceServers;
  if ((!iceServers || iceServers.length === 0) && connector.getIceServers) {
    try {
      const turnConfig = await connector.getIceServers();
      if (turnConfig && turnConfig.length > 0) {
        iceServers = turnConfig;
        console.log("[RFWebRTC] Using TURN servers from connector");
      }
    } catch (err) {
      console.warn("[RFWebRTC] Failed to fetch TURN config, using defaults:", err);
    }
  }

  // Step 2: Prepare peer connection and create offer
  const { pc, offer, remoteStreamPromise, dataChannel, uploadChannel } = await preparePeerConnection(
    localStream,
    file,
    iceServers
  );

  // Update wrtcParams with resolved iceServers so server also uses them
  // For file uploads, default to batch mode (realtimeProcessing: false)
  const resolvedWrtcParams = {
    ...wrtcParams,
    iceServers: iceServers,
    realtimeProcessing: wrtcParams.realtimeProcessing ?? !isFile
  };

  // Step 3: Call connector.connectWrtc to exchange SDP and get answer
  const answer = await connector.connectWrtc(
    { sdp: offer.sdp!, type: offer.type! },
    resolvedWrtcParams
  );

  // API returns sdp and type at root level
  const sdpAnswer = { sdp: answer.sdp, type: answer.type } as RTCSessionDescriptionInit;

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

  // Step 6: Optimize quality for MediaStream (disable downsampling by default)
  if (localStream) {
    const shouldDisableDownscaling = options.disableInputStreamDownscaling !== false;
    if (shouldDisableDownscaling) {
      await disableInputStreamDownscaling(pc);
    }
  }

  // Get apiKey from connector if available (for cleanup)
  const apiKey = connector._apiKey || null;

  // Step 7: Create connection object
  const connection = new RFWebRTCConnection(
    pc,
    remoteStreamPromise,
    pipelineId,
    apiKey,
    dataChannel,
    {
      localStream,
      uploadChannel,
      onData,
      onComplete
    }
  );

  // Step 8: Start file upload if applicable (runs in background)
  if (file && uploadChannel) {
    connection.startUpload(file, onFileUploadProgress).catch(err => {
      console.error("[RFWebRTC] Upload error:", err);
    });
  }

  return connection;
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
  if (source instanceof File) {
    throw new Error("useStream requires a MediaStream. Use useVideoFile for File uploads.");
  }

  return baseUseStream({
    source,
    connector,
    wrtcParams,
    onData,
    options
  });
}

/**
 * Parameters for useVideoFile function
 */
export interface UseVideoFileParams {
  /** The video file to upload */
  file: File;
  /** Connector for WebRTC signaling */
  connector: Connector;
  /** WebRTC parameters for the workflow */
  wrtcParams: WebRTCParams;
  /** Callback for inference results */
  onData?: (data: WebRTCOutputData) => void;
  /** Callback for upload progress */
  onUploadProgress?: (bytesUploaded: number, totalBytes: number) => void;
  /** Callback when processing completes (datachannel closes) */
  onComplete?: () => void;
}

/**
 * Upload a video file for batch inference processing
 *
 * Creates a WebRTC connection to Roboflow for uploading a video file
 * and receiving inference results. The file is uploaded via datachannel
 * with intelligent backpressure handling.
 *
 * @param params - Connection parameters
 * @returns Promise resolving to RFWebRTCConnection
 *
 * @example
 * ```typescript
 * import { connectors, webrtc } from '@roboflow/inference-sdk';
 *
 * const connector = connectors.withApiKey("your-api-key");
 * const connection = await webrtc.useVideoFile({
 *   file: videoFile,
 *   connector,
 *   wrtcParams: {
 *     workflowSpec: { ... },
 *     imageInputName: "image",
 *     dataOutputNames: ["predictions"]
 *   },
 *   onData: (data) => {
 *     console.log("Inference results:", data);
 *     if (data.processing_complete) {
 *       console.log("Processing complete!");
 *     }
 *   },
 *   onUploadProgress: (uploaded, total) => {
 *     console.log(`Upload: ${(uploaded / total * 100).toFixed(1)}%`);
 *   }
 * });
 *
 * // When done
 * await connection.cleanup();
 * ```
 */
export async function useVideoFile({
  file,
  connector,
  wrtcParams,
  onData,
  onUploadProgress,
  onComplete
}: UseVideoFileParams): Promise<RFWebRTCConnection> {
  return baseUseStream({
    source: file,
    connector,
    wrtcParams: {
      ...wrtcParams,
      realtimeProcessing: wrtcParams.realtimeProcessing ?? true
    },
    onData,
    onComplete,
    onFileUploadProgress: onUploadProgress
  });
}
