/**
 * WHIP publishing into a temporary session and WHEP playback of a job's annotated output. The
 * relay offers ICE-TCP host candidates in its answer, so neither needs ICE servers. Grant URLs
 * carry stream credentials: they never reach an error message or a log.
 */
import { StreamingApiError } from "./api";

const ICE_GATHERING_TIMEOUT_MS = 1_000;
const OFFER_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 10_000;
const GRACE_MS = 1_500;
const STALL_CHECK_MS = 2_000;
const STALL_CHECKS = 3;

/** Without trickle ICE over HTTP the offer waits for candidates, but never longer than a second. */
function iceGathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    check();
  });
}

/** The WHIP and WHEP exchange: one SDP offer POSTed to the grant URL, the answer in the body. */
async function negotiate(
  pc: RTCPeerConnection,
  url: string,
  redirect?: RequestRedirect
): Promise<{ answer: string; location: string | null }> {
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription?.sdp,
    redirect,
    signal: AbortSignal.timeout(OFFER_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new StreamingApiError(
      response.status,
      `The video relay refused the WebRTC offer (status ${response.status}).`
    );
  }
  return { answer: await response.text(), location: response.headers.get("Location") };
}

/**
 * The processor decodes H.264 and H.265 only, and browsers offer VP8 first: H.264 moves to the
 * front (packetization-mode=1 first), the rest keep the browser's order behind it.
 */
function preferH264(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
  const isH264 = (codec: RTCRtpCodec) => codec.mimeType.toLowerCase() === "video/h264";
  const h264 = codecs.filter(isH264);
  if (h264.length === 0 || typeof transceiver.setCodecPreferences !== "function") return;
  const nonInterleaved = h264.filter((codec) =>
    codec.sdpFmtpLine?.includes("packetization-mode=1")
  );
  try {
    transceiver.setCodecPreferences([
      ...nonInterleaved,
      ...h264.filter((codec) => !nonInterleaved.includes(codec)),
      ...codecs.filter((codec) => !isH264(codec))
    ]);
  } catch {
    // a preference is not worth failing the publish: the browser's own order still works
  }
}

function connected(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (pc.connectionState === "connected") settle();
      else if (pc.connectionState === "failed") {
        settle(new Error("The WebRTC connection to the Cloud Streaming relay failed."));
      }
    };
    const timer = setTimeout(
      () =>
        settle(new Error("The WebRTC connection to the Cloud Streaming relay did not come up.")),
      CONNECT_TIMEOUT_MS
    );
    pc.addEventListener("connectionstatechange", check);
    check();
  });
}

export interface Publisher {
  /** Resolves when publishing stops on its own: the connection failed or a track ended. */
  readonly lost: Promise<void>;
  /** Stops publishing and releases the relay session. The caller's tracks keep running. */
  close(options?: { keepalive?: boolean }): void;
}

/**
 * Publishes the stream's video into a temporary session: one POST to its one-use grant, then a
 * DELETE on the session the relay names in `Location` when done. Resolves once media flows.
 */
export async function publish(media: MediaStream, whipUrl: string): Promise<Publisher> {
  const tracks = media.getVideoTracks();
  const pc = new RTCPeerConnection();
  let resource: string | undefined;
  let closed = false;
  let markLost!: () => void;
  const lost = new Promise<void>((resolve) => {
    markLost = resolve;
  });

  const close = ({ keepalive = false } = {}) => {
    if (closed) return;
    closed = true;
    tracks.forEach((track) => track.removeEventListener("ended", onLost));
    pc.close();
    if (resource) fetch(resource, { method: "DELETE", keepalive }).catch(() => undefined);
  };
  const onLost = () => {
    if (closed) return;
    close();
    markLost();
  };

  try {
    tracks.forEach((track) => preferH264(pc.addTransceiver(track, { direction: "sendonly" })));
    // "error": a grant-bearing URL is never followed to another origin
    const { answer, location } = await negotiate(pc, whipUrl, "error");
    if (!location) throw new Error("The video relay named no WHIP session.");
    const session = new URL(location, whipUrl);
    if (session.origin !== new URL(whipUrl).origin) {
      throw new Error("The video relay named a WHIP session on another origin.");
    }
    resource = session.toString();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    await connected(pc);
  } catch (error) {
    close();
    throw error;
  }
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") onLost();
  });
  tracks.forEach((track) => track.addEventListener("ended", onLost));
  return { lost, close };
}

export interface Player {
  /** The annotated video. Reconnects replace its track in place, so a `<video>` keeps playing. */
  readonly stream: MediaStream;
  /** Resolves when the first video arrives. */
  readonly playing: Promise<void>;
  /** Plays from `url`, kept for later reconnects; a different `session` reconnects at once. */
  play(url: string, session: string): void;
  close(): void;
}

/**
 * Plays a job's output over WHEP. The relay drops the session whenever the processor restarts its
 * publisher (another output, a new execution), so a lost, muted or stalled session reconnects
 * until the player is closed.
 */
export function createPlayer(): Player {
  const stream = new MediaStream();
  let url: string | undefined;
  let session: string | undefined;
  let pc: RTCPeerConnection | undefined;
  let closed = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let markPlaying!: () => void;
  const playing = new Promise<void>((resolve) => {
    markPlaying = resolve;
  });

  function drop() {
    clearTimeout(retryTimer);
    clearTimeout(graceTimer);
    pc?.close();
    pc = undefined;
  }

  function reconnect(delay: number) {
    drop();
    retryTimer = setTimeout(connect, delay);
  }

  /** Reconnects unless `healthy()` holds again after a short grace. */
  function unlessRecovered(current: RTCPeerConnection, healthy: () => boolean) {
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      if (pc === current && !healthy()) reconnect(0);
    }, GRACE_MS);
  }

  async function connect() {
    if (closed || !url) return;
    const current = new RTCPeerConnection();
    pc = current;
    current.addTransceiver("video", { direction: "recvonly" });
    current.addTransceiver("audio", { direction: "recvonly" });
    current.ontrack = ({ track }) => {
      if (pc !== current || track.kind !== "video") return;
      stream.getVideoTracks().forEach((old) => stream.removeTrack(old));
      stream.addTrack(track);
      failures = 0;
      markPlaying();
      track.onmute = () => unlessRecovered(current, () => !track.muted);
      track.onended = () => {
        if (pc === current) reconnect(0);
      };
    };
    current.onconnectionstatechange = () => {
      if (pc !== current) return;
      const state = current.connectionState;
      if (state === "failed" || state === "closed") reconnect(RETRY_MS);
      if (state === "disconnected") {
        unlessRecovered(current, () => current.connectionState !== "disconnected");
      }
    };
    try {
      const { answer } = await negotiate(current, url);
      if (pc !== current) return;
      await current.setRemoteDescription({ type: "answer", sdp: answer });
    } catch {
      // the output may not be published yet: it starts after the watch reaches the processor
      if (pc !== current) return;
      failures += 1;
      reconnect(Math.min(MAX_RETRY_MS, RETRY_MS * failures));
    }
  }

  // A session whose packets stop counting is dead whichever event the browser failed to fire.
  let lastPackets = -1;
  let stalledChecks = 0;
  const stallWatch = setInterval(async () => {
    const current = pc;
    if (!current || current.connectionState !== "connected") return;
    const reports = await current.getStats().catch(() => undefined);
    if (!reports || pc !== current) return;
    let packets = 0;
    reports.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video")
        packets = report.packetsReceived;
    });
    stalledChecks = packets === lastPackets ? stalledChecks + 1 : 0;
    lastPackets = packets;
    if (stalledChecks >= STALL_CHECKS) {
      stalledChecks = 0;
      reconnect(0);
    }
  }, STALL_CHECK_MS);

  return {
    stream,
    playing,
    play(nextUrl, nextSession) {
      url = nextUrl;
      if (nextSession === session) return;
      session = nextSession;
      failures = 0;
      reconnect(0);
    },
    close() {
      closed = true;
      clearInterval(stallWatch);
      drop();
    }
  };
}
