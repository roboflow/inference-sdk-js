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
 * Bounding box prediction from an object detection model.
 * Coordinates are in image pixel space with x/y at the box center.
 */
export interface DetectionPrediction {
  /** Center x coordinate in pixels */
  x: number;
  /** Center y coordinate in pixels */
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: string;
  class_id: number;
  detection_id: string;
  parent_id?: string;
}

/** A single body keypoint from a pose estimation model. */
export interface Keypoint {
  x: number;
  y: number;
  /** Visibility confidence (0–1). Filter below 0.3 before rendering. */
  confidence: number;
  /** Numeric keypoint index — ordering is defined by the model's keypoint schema */
  class_id: number;
  /** Keypoint name e.g. "nose", "left_shoulder" */
  class: string;
}

/** A detected person with bounding box and body keypoints. */
export interface KeypointPrediction extends DetectionPrediction {
  keypoints: Keypoint[];
}

/** A single class score from a classification model. */
export interface ClassificationPrediction {
  class: string;
  class_id: number;
  confidence: number;
}

/**
 * Shape returned by a `JsonField` output block connected to an object
 * detection model step.
 */
export interface DetectionOutput {
  image: { width: number; height: number };
  predictions: DetectionPrediction[];
}

/**
 * Shape returned by a `JsonField` output block connected to a keypoint
 * detection model step.
 */
export interface PoseDetectionOutput {
  image: { width: number; height: number };
  predictions: KeypointPrediction[];
}

/**
 * Shape returned by a `JsonField` output block connected to a
 * classification model step.
 */
export interface ClassificationOutput {
  image: { width: number; height: number };
  predictions: ClassificationPrediction[];
  top: string;
  confidence: number;
}

/**
 * Output data from WebRTC inference
 *
 * This is the structure of data received via the `onData` callback
 * for both live streams and video file uploads.
 *
 * The optional type parameter `T` narrows `serialized_output_data` to match
 * your workflow's output shape. Defaults to `Record<string, any>` for
 * backwards compatibility.
 *
 * @example
 * ```typescript
 * onData: (data: WebRTCOutputData<{ predictions: PoseDetectionOutput }>) => {
 *   const people = data.serialized_output_data?.predictions.predictions;
 * }
 * ```
 */
export interface WebRTCOutputData<T = Record<string, any>> {
  /** Workflow output data typed to match your workflow's output shape */
  serialized_output_data?: T | null;
  /** Video frame metadata */
  video_metadata?: WebRTCVideoMetadata | null;
  /** List of error messages from processing */
  errors: string[];
  /** Signals end of video file processing */
  processing_complete: boolean;
}

/**
 * Lifecycle hooks for customizing WebRTC connection behavior.
 *
 * These hooks allow consumers to inject custom logic at key stages
 * of the WebRTC connection lifecycle. For other customization (like
 * connection state monitoring), add listeners directly to the
 * peerConnection in onPeerConnectionCreated.
 *
 * @example
 * ```typescript
 * const conn = await useStream({
 *   // ...
 *   hooks: {
 *     onPeerConnectionCreated: (pc) => {
 *       // Add connection state listener
 *       pc.addEventListener('connectionstatechange', () => {
 *         console.log('State:', pc.connectionState);
 *         if (pc.connectionState === 'connected') {
 *           // Configure sender parameters after connection
 *         }
 *       });
 *     },
 *     onTrackAdded: (track, sender, pc) => {
 *       track.contentHint = 'motion';
 *       // Apply codec preferences...
 *     },
 *     onOfferCreated: (offer) => {
 *       // Munge SDP for bitrate hints
 *       return { ...offer, sdp: mungedSdp };
 *     }
 *   }
 * });
 * ```
 */
export interface WebRTCHooks {
  /**
   * Called after RTCPeerConnection is created, before tracks are added.
   * Use this to configure ICE handlers, add event listeners, or set up
   * custom connection monitoring.
   *
   * @param pc - The newly created RTCPeerConnection
   */
  onPeerConnectionCreated?: (pc: RTCPeerConnection) => void | Promise<void>;

  /**
   * Called after a video track is added to the connection but before offer creation.
   * Use this to configure codec preferences, set content hints, or apply
   * track-level settings.
   *
   * @param track - The video track that was added
   * @param sender - The RTCRtpSender for the track
   * @param pc - The peer connection
   */
  onTrackAdded?: (track: MediaStreamTrack, sender: RTCRtpSender, pc: RTCPeerConnection) => void | Promise<void>;

  /**
   * Called after the SDP offer is created, before setting local description.
   * Use this to modify the SDP (e.g., add bitrate hints, filter codecs).
   * Return a modified offer or undefined/void to use the original.
   *
   * @param offer - The created SDP offer
   * @returns Modified offer, or undefined to use original
   */
  onOfferCreated?: (offer: RTCSessionDescriptionInit) => RTCSessionDescriptionInit | void | Promise<RTCSessionDescriptionInit | void>;
}
