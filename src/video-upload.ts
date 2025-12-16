/**
 * Video file upload via WebRTC datachannel
 *
 * This module provides the FileUploader class for chunked file uploads
 * through WebRTC datachannels with backpressure handling.
 */

/**
 * Configuration constants for file upload (matching Python SDK)
 */
const CHUNK_SIZE = 49152;       // 49KB - safe for WebRTC
const BUFFER_LIMIT = 262144;    // 256KB - backpressure threshold
const POLL_INTERVAL = 10;       // 10ms buffer check interval

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
