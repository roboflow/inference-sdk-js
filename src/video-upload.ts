/**
 * Video file upload via WebRTC datachannel
 *
 * This module enables uploading video files for batch inference processing
 * through Roboflow's WebRTC infrastructure.
 */

import { InferenceHTTPClient, Connector, WebRTCParams, RTCIceServerConfig } from "./inference-api";
import { ChunkReassembler, parseBinaryHeader } from "./webrtc";
import { WebRTCOutputData } from "./webrtc-types";

/**
 * Configuration constants (matching Python SDK)
 */
const CHUNK_SIZE = 49152;       // 49KB - safe for WebRTC
const BUFFER_LIMIT = 262144;    // 256KB - backpressure threshold
const POLL_INTERVAL = 10;       // 10ms buffer check interval

const DEFAULT_ICE_SERVERS: RTCIceServerConfig[] = [
  { urls: ["stun:stun.l.google.com:19302"] }
];

/**
 * Wait for ICE gathering to complete or timeout
 */
async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 6000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;

  const startTime = Date.now();
  let hasSrflx = false;

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

    const errorHandler = (err: Event) => {
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
 * Helper to sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * FileUploader handles chunked file upload with backpressure
 *
 * Uploads files through a WebRTC datachannel in 49KB chunks with
 * intelligent backpressure handling to prevent overwhelming the network.
 */
export class FileUploader {
  private file: File;
  private channel: RTCDataChannel;
  private totalChunks: number;
  private cancelled: boolean = false;

  constructor(file: File, channel: RTCDataChannel) {
    this.file = file;
    this.channel = channel;
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  }

  /**
   * Cancel the upload
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Upload the file in chunks with backpressure handling
   *
   * @param onProgress - Optional callback for progress updates (bytesUploaded, totalBytes)
   */
  async upload(onProgress?: (bytesUploaded: number, totalBytes: number) => void): Promise<void> {
    const totalBytes = this.file.size;

    for (let chunkIndex = 0; chunkIndex < this.totalChunks; chunkIndex++) {
      // Check for cancellation
      if (this.cancelled) {
        throw new Error("Upload cancelled");
      }

      // Check channel state
      if (this.channel.readyState !== "open") {
        throw new Error("Video upload interrupted");
      }

      // Read chunk from file
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalBytes);
      const chunkBlob = this.file.slice(start, end);
      const chunkData = new Uint8Array(await chunkBlob.arrayBuffer());

      // Create message with 8-byte header (chunkIndex + totalChunks as uint32 LE)
      const message = new ArrayBuffer(8 + chunkData.length);
      const view = new DataView(message);
      view.setUint32(0, chunkIndex, true);      // little-endian
      view.setUint32(4, this.totalChunks, true); // little-endian
      new Uint8Array(message, 8).set(chunkData);

      // Backpressure: wait for buffer to drain
      while (this.channel.bufferedAmount > BUFFER_LIMIT) {
        if (this.channel.readyState !== "open") {
          throw new Error("Video upload interrupted");
        }
        await sleep(POLL_INTERVAL);
      }

      // Send chunk
      this.channel.send(message);

      // Report progress
      if (onProgress) {
        onProgress(end, totalBytes);
      }
    }
  }
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
 * VideoFileConnection manages the WebRTC connection for file upload
 *
 * Represents an active WebRTC connection to Roboflow for file-based batch inference.
 */
export class VideoFileConnection {
  private pc: RTCPeerConnection;
  private remoteStreamPromise: Promise<MediaStream>;
  private pipelineId: string | null;
  private apiKey: string | null;
  private controlChannel: RTCDataChannel;
  private uploadChannel: RTCDataChannel;
  private reassembler: ChunkReassembler;
  private uploader: FileUploader | null = null;

  /** @private */
  constructor(
    pc: RTCPeerConnection,
    remoteStreamPromise: Promise<MediaStream>,
    pipelineId: string | null,
    apiKey: string | null,
    controlChannel: RTCDataChannel,
    uploadChannel: RTCDataChannel,
    onData?: (data: any) => void,
    onComplete?: () => void
  ) {
    this.pc = pc;
    this.remoteStreamPromise = remoteStreamPromise;
    this.pipelineId = pipelineId;
    this.apiKey = apiKey;
    this.controlChannel = controlChannel;
    this.uploadChannel = uploadChannel;
    this.reassembler = new ChunkReassembler();

    // Set binary mode for control channel
    this.controlChannel.binaryType = "arraybuffer";

    // Setup control channel event listeners for receiving results
    if (onData) {
      this.controlChannel.addEventListener("message", (messageEvent: MessageEvent) => {
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
            // Fallback for string messages
            const data = JSON.parse(messageEvent.data);
            onData(data);
          }
        } catch (err) {
          console.error("[VideoFileConnection] Failed to parse data channel message:", err);
        }
      });

      this.controlChannel.addEventListener("error", (error) => {
        console.error("[VideoFileConnection] Control channel error:", error);
      });
    }

    // Handle channel close - call onComplete when processing finishes
    this.controlChannel.addEventListener("close", () => {
      this.reassembler.clear();
      if (onComplete) {
        onComplete();
      }
    });
  }

  /**
   * Get the remote stream (processed video from Roboflow)
   *
   * @returns Promise resolving to the remote MediaStream
   */
  async remoteStream(): Promise<MediaStream> {
    return await this.remoteStreamPromise;
  }

  /**
   * Cleanup and close connection
   *
   * Terminates the pipeline on Roboflow and closes the peer connection.
   *
   * @returns Promise that resolves when cleanup is complete
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
        console.warn("[VideoFileConnection] Failed to terminate pipeline:", err);
      }
    }

    // Close peer connection
    if (this.pc && this.pc.connectionState !== "closed") {
      this.pc.close();
    }
  }

  /**
   * Reconfigure pipeline outputs at runtime
   *
   * @param config - Output configuration
   */
  reconfigureOutputs(config: { streamOutput?: string[] | null; dataOutput?: string[] | null }): void {
    const message: any = {};

    if (config.streamOutput !== undefined) {
      message.stream_output = config.streamOutput;
    }

    if (config.dataOutput !== undefined) {
      message.data_output = config.dataOutput;
    }

    if (this.controlChannel.readyState !== "open") {
      console.warn("[VideoFileConnection] Control channel is not open. Current state:", this.controlChannel.readyState);
      return;
    }

    try {
      this.controlChannel.send(JSON.stringify(message));
    } catch (err) {
      console.error("[VideoFileConnection] Failed to send reconfigure message:", err);
    }
  }

  /**
   * Start the file upload (internal use)
   * @private
   */
  async _startUpload(file: File, onProgress?: (bytesUploaded: number, totalBytes: number) => void): Promise<void> {
    this.uploader = new FileUploader(file, this.uploadChannel);
    await this.uploader.upload(onProgress);
  }
}

/**
 * Setup remote stream listener
 */
function setupRemoteStreamListener(pc: RTCPeerConnection): Promise<MediaStream> {
  return new Promise((resolve) => {
    pc.addEventListener("track", (event: RTCTrackEvent) => {
      if (event.streams && event.streams[0]) {
        resolve(event.streams[0]);
      }
    });
  });
}

/**
 * Upload a video file for batch inference processing
 *
 * Creates a WebRTC connection to Roboflow for uploading a video file
 * and receiving inference results. The file is uploaded via datachannel
 * with intelligent backpressure handling.
 *
 * @param params - Connection parameters
 * @returns Promise resolving to VideoFileConnection
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
}: UseVideoFileParams): Promise<VideoFileConnection> {
  // Validate connector
  if (!connector || typeof connector.connectWrtc !== "function") {
    throw new Error("connector must have a connectWrtc method");
  }

  // Step 1: Determine ICE servers to use
  let iceServers = wrtcParams.iceServers;
  if ((!iceServers || iceServers.length === 0) && connector.getIceServers) {
    try {
      const turnConfig = await connector.getIceServers();
      if (turnConfig && turnConfig.length > 0) {
        iceServers = turnConfig;
        console.log("[VideoFile] Using TURN servers from connector");
      }
    } catch (err) {
      console.warn("[VideoFile] Failed to fetch TURN config, using defaults:", err);
    }
  }

  const effectiveIceServers = iceServers ?? DEFAULT_ICE_SERVERS;

  // Step 2: Create peer connection
  const pc = new RTCPeerConnection({
    iceServers: effectiveIceServers as RTCIceServer[]
  });

  // Step 3: Add receive-only video transceiver (no local media)
  try {
    pc.addTransceiver("video", { direction: "recvonly" });
  } catch (err) {
    console.warn("[VideoFile] Could not add transceiver:", err);
  }

  // Setup remote stream listener
  const remoteStreamPromise = setupRemoteStreamListener(pc);

  // Step 4: Create datachannels
  const controlChannel = pc.createDataChannel("roboflow-control", {
    ordered: true
  });

  const uploadChannel = pc.createDataChannel("video_upload", {
    ordered: true
  });

  // Step 5: Create SDP offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Step 6: Wait for ICE gathering
  await waitForIceGathering(pc);

  // Step 7: Update wrtcParams with resolved ICE servers
  // Default to realtimeProcessing: false for batch mode, but allow override
  const resolvedWrtcParams = {
    ...wrtcParams,
    iceServers: iceServers,
    realtimeProcessing: wrtcParams.realtimeProcessing ?? false
  };

  // Step 8: Call connector to exchange SDP
  const answer = await connector.connectWrtc(
    { sdp: pc.localDescription!.sdp!, type: pc.localDescription!.type! },
    resolvedWrtcParams
  );

  const sdpAnswer = { sdp: answer.sdp, type: answer.type };

  if (!sdpAnswer?.sdp || !sdpAnswer?.type) {
    console.error("[VideoFile] Invalid answer from server:", answer);
    throw new Error("connector.connectWrtc must return answer with sdp and type");
  }

  const pipelineId = answer?.context?.pipeline_id || null;

  // Step 9: Set remote description
  await pc.setRemoteDescription(sdpAnswer);

  // Step 10: Wait for connection to establish
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

  // Step 11: Wait for upload channel to open
  await waitForChannelOpen(uploadChannel);

  // Get apiKey from connector if available (for cleanup)
  const apiKey = connector._apiKey || null;

  // Step 12: Create connection object
  const connection = new VideoFileConnection(
    pc,
    remoteStreamPromise,
    pipelineId,
    apiKey,
    controlChannel,
    uploadChannel,
    onData,
    onComplete
  );

  // Step 13: Start upload (non-blocking, runs in background)
  connection._startUpload(file, onUploadProgress).catch(err => {
    console.error("[VideoFile] Upload error:", err);
  });

  return connection;
}
