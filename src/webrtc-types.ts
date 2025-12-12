/**
 * Shared types for WebRTC inference
 *
 * These types are used by both live streaming (useStream) and
 * video file upload (useVideoFile) functionality.
 */

/**
 * Video metadata from WebRTC inference results
 *
 * Contains frame timing and identification information.
 */
export interface WebRTCVideoMetadata {
  /** Sequential frame identifier */
  frame_id: number;
  /** ISO 8601 timestamp when frame was received by server */
  received_at: string;
  /** Presentation timestamp from video container */
  pts?: number | null;
  /** Time base for pts conversion (pts * time_base = seconds) */
  time_base?: number | null;
  /** FPS declared in video metadata or by client */
  declared_fps?: number | null;
  /** Actual measured FPS during processing */
  measured_fps?: number | null;
  /** Signals end of video file processing */
  processing_complete?: boolean;
}

/**
 * Output data from WebRTC inference
 *
 * This is the structure of data received via the `onData` callback
 * for both live streams and video file uploads.
 */
export interface WebRTCOutputData {
  /** Workflow output data (predictions, counts, etc.) */
  serialized_output_data?: Record<string, any> | null;
  /** Video frame metadata */
  video_metadata?: WebRTCVideoMetadata | null;
  /** List of error messages from processing */
  errors: string[];
  /** Signals end of video file processing */
  processing_complete: boolean;
}
