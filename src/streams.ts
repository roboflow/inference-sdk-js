/**
 * Opens a camera with the given constraints, falling back to any camera (video only) when they
 * cannot be met.
 *
 * @example
 * ```typescript
 * const camera = await streams.useCamera({
 *   video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
 *   audio: false
 * });
 * ```
 */
export async function useCamera(
  constraints: MediaStreamConstraints = { video: true }
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

/** Stops every track of the stream, which releases the camera. */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
