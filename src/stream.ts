import {
  asError,
  retryable,
  StreamingApiError,
  type Connector,
  type JobRequest,
  type JobState,
  type ProcessorSize,
  type ResultSubscription,
  type TemporarySession,
  type VideoJob
} from "./api";
import { followResults, type ResultGap, type StreamResult } from "./results";
import { createPlayer, publish, type Player, type Publisher } from "./webrtc";

const RENEW_MS = 30_000;
const RETRY_MS = 2_000;
const TRIES = 3;

export interface StreamCallbacks {
  /** One processed frame's results. */
  onResult?: (result: StreamResult) => void;
  /** Results the feed could not deliver. */
  onGap?: (gap: ResultGap) => void;
  /** The job ended by itself; `reason` is how: `completed`, `cancelled` or `error`. */
  onEnd?: (end: { reason: string }) => void;
  /** The stream failed and is over. */
  onError?: (error: Error) => void;
}

export interface StartStreamOptions extends StreamCallbacks {
  connector: Connector;
  /** A MediaStream to publish from this browser, or the id of a registered source. */
  source: MediaStream | string;
  /** A saved Workflow's id, or an inline Workflow specification. */
  workflow: string | Record<string, unknown>;
  /** Values for the Workflow's declared inputs. */
  parameters?: Record<string, unknown>;
  /** The image output the video shows by default. */
  imageOutput?: string;
  maxFps?: number;
  processorSize?: ProcessorSize;
  /**
   * `preview` (default) ends when the stream stops or stops renewing, after one hour at most.
   * `deployment` (registered sources only) keeps running until `stop()` or a cancel elsewhere.
   */
  purpose?: "preview" | "deployment";
}

export interface AttachStreamOptions extends StreamCallbacks {
  connector: Connector;
  jobId: string;
}

/** One Workflow run (a Cloud Streaming job) on one source. */
export interface CloudStream {
  /** The job; follows it when it continues under a successor id. */
  readonly jobId: string;
  readonly sourceId: string;
  /**
   * The annotated video, once the job runs and its output arrives. Watching renews every 30 s
   * from the first call until the stream stops; another `output` switches the job's selection.
   */
  remoteStream(output?: string): Promise<MediaStream>;
  /** The MediaStream this stream publishes, if any. */
  localStream(): MediaStream | null;
  /**
   * Cancels the job this stream started, stops the session it allocated, and releases the
   * connections. An attached stream only releases. Safe to call more than once.
   */
  stop(): Promise<void>;
}

/** Starts a Workflow on a source and returns the stream once the job exists. */
export async function startStream(options: StartStreamOptions): Promise<CloudStream> {
  const { connector, source, workflow, purpose = "preview", processorSize } = options;
  const job: JobRequest = {
    ...(typeof workflow === "string"
      ? { workflowUrl: workflow }
      : { workflowSpecification: workflow }),
    workflowParameters: options.parameters,
    imageOutput: options.imageOutput,
    maxFps: options.maxFps,
    processorSize,
    tier: processorSize === "cpu-standard-v1" ? "cpu" : undefined,
    purpose
  };
  if (typeof source === "string") {
    return new Stream(connector, options, await startJob(connector, source, job), true);
  }
  if (purpose !== "preview") {
    throw new Error("A MediaStream source runs previews only; deploy on a registered source.");
  }
  if (!source.getVideoTracks().some((track) => track.readyState === "live")) {
    throw new Error("The MediaStream has no live video track to publish.");
  }
  for (let attempt = 1; ; attempt += 1) {
    const session = await createSession(connector);
    let publisher: Publisher;
    try {
      publisher = await publish(source, session.whipUrl);
    } catch (error) {
      await stopSession(connector, session.sourceId);
      // a refused grant is final; a lost or failed exchange gets a fresh session
      if (attempt < TRIES && retryable(error)) continue;
      throw error;
    }
    try {
      const started = await startJob(connector, session.sourceId, job);
      return new Stream(connector, options, started, true, { media: source, publisher });
    } catch (error) {
      publisher.close();
      await stopSession(connector, session.sourceId);
      throw error;
    }
  }
}

/** Follows a job that already runs: its results and video, without owning it. */
export async function attachStream(options: AttachStreamOptions): Promise<CloudStream> {
  const { job } = await options.connector.request({ operation: "getJob", jobId: options.jobId });
  return new Stream(options.connector, options, job, false);
}

/** Retries lost requests and server failures with the same idempotency key. */
async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= TRIES || !retryable(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

async function createSession(connector: Connector): Promise<TemporarySession> {
  const idempotencyKey = crypto.randomUUID();
  try {
    return await withRetries(() =>
      connector.request({ operation: "createSession", name: "Inference SDK", idempotencyKey })
    );
  } catch (error) {
    if (error instanceof StreamingApiError && error.status === 409) {
      throw new StreamingApiError(
        409,
        `Cloud Streaming has no browser session to offer (${error.message}). Either four browser ` +
          "sessions are already starting in this workspace, or browser streaming is not available " +
          "in this region (EU has none)."
      );
    }
    throw error;
  }
}

async function startJob(
  connector: Connector,
  sourceId: string,
  job: JobRequest
): Promise<VideoJob> {
  const idempotencyKey = crypto.randomUUID();
  const started = await withRetries(() =>
    connector.request({ operation: "startJob", sourceId, idempotencyKey, job })
  );
  return started.job;
}

/** Best effort: a session also ends when its publisher goes away. */
function stopSession(connector: Connector, sourceId: string, keepalive = false): Promise<unknown> {
  return connector
    .request({ operation: "stopSession", sourceId }, { keepalive })
    .catch(() => undefined);
}

/** Runs `renew` now and again after the delay it returns, until it returns undefined. */
function renewal(renew: () => Promise<number | undefined>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let again = false;
  let stopped = false;
  async function run(): Promise<void> {
    clearTimeout(timer);
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const delay = await renew();
    busy = false;
    if (stopped) return;
    if (again) {
      again = false;
      void run();
    } else if (delay !== undefined) {
      timer = setTimeout(run, delay);
    }
  }
  return {
    /** Renews now, or right after the renewal in flight. */
    now: () => void run(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    }
  };
}

type VideoRequest = {
  call: number;
  resolve: (stream: MediaStream) => void;
  reject: (error: Error) => void;
};

class Stream implements CloudStream {
  jobId: string;
  readonly sourceId: string;
  private readonly purpose: VideoJob["purpose"];
  private state: JobState | undefined;
  private execution: string | undefined;
  private jobOver = false;
  private released = false;
  private stopping: Promise<void> | undefined;
  private readonly stopResults: () => void;
  private readonly holding = renewal(() => this.renewHold());
  private readonly watching = renewal(() => this.renewWatch());
  /** The image output to watch; undefined is the job's default. */
  private output: string | undefined;
  private grantedOutput: string | undefined;
  private player: Player | undefined;
  private playing = false;
  private videoRequests: VideoRequest[] = [];
  private videoCalls = 0;
  private grantedCalls = 0;

  constructor(
    private readonly connector: Connector,
    private readonly callbacks: StreamCallbacks,
    job: VideoJob,
    private readonly ownsJob: boolean,
    private readonly session?: { media: MediaStream; publisher: Publisher }
  ) {
    this.jobId = job.id;
    this.sourceId = job.sourceId;
    this.purpose = job.purpose;
    this.stopResults = followResults({
      connector,
      jobId: job.id,
      onResult: callbacks.onResult,
      onGap: callbacks.onGap,
      onSubscription: (subscription) => this.observe(subscription),
      onSuccessor: (jobId) => this.follow(jobId),
      onEnd: (state) => this.end(state),
      onError: (error) => this.fail(error)
    });
    if (session) {
      void session.publisher.lost.then(() =>
        this.fail(new Error("The published video stopped, which ends its Cloud Streaming session."))
      );
      this.holding.now();
    }
    if (this.ownsPreview && typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
    }
  }

  /** A preview this stream started; it should not outlive the page. */
  private get ownsPreview(): boolean {
    return this.ownsJob && this.purpose === "preview";
  }

  /** A preview on a registered source stays alive through watch renewals. */
  private get keepsAliveByWatching(): boolean {
    return this.ownsPreview && !this.session;
  }

  private get running(): boolean {
    return this.state === "claimed" || this.state === "running";
  }

  remoteStream(output?: string): Promise<MediaStream> {
    if (this.released) return Promise.reject(new Error("The stream has stopped."));
    if (output !== undefined) this.output = output;
    if (!this.player) {
      const player = createPlayer();
      this.player = player;
      void player.playing.then(() => {
        if (this.player !== player) return;
        this.playing = true;
        this.settleVideo();
      });
    }
    const call = ++this.videoCalls;
    const video = new Promise<MediaStream>((resolve, reject) => {
      this.videoRequests.push({ call, resolve, reject });
    });
    this.watching.now();
    return video;
  }

  localStream(): MediaStream | null {
    return this.session?.media ?? null;
  }

  stop(): Promise<void> {
    return this.finish(new Error("The stream was stopped."));
  }

  private readonly onPageHide = () => {
    this.fail(new Error("The page was left, which stops its previews."), true);
  };

  /**
   * Stops the stream, whatever asks first: the caller, the page, the job's end or a failure. A
   * cancel that failed is sent again by the next call.
   */
  private finish(reason: Error, keepalive = false): Promise<void> {
    this.stopping ??= this.shutdown(reason, keepalive).catch((error: unknown) => {
      this.stopping = undefined;
      throw error;
    });
    return this.stopping;
  }

  private async shutdown(reason: Error, keepalive: boolean): Promise<void> {
    this.release(reason, keepalive);
    const { connector, jobId } = this;
    const sessionStopped = this.session && stopSession(connector, this.sourceId, keepalive);
    if (this.ownsJob && !this.jobOver) {
      await withRetries(() => connector.request({ operation: "cancelJob", jobId }, { keepalive }));
    }
    await sessionStopped;
  }

  /** Releases everything this browser holds; the job and session are left as they are. */
  private release(reason: Error, keepalive = false): void {
    if (this.released) return;
    this.released = true;
    this.stopResults();
    this.holding.stop();
    this.watching.stop();
    this.player?.close();
    this.session?.publisher.close({ keepalive });
    this.videoRequests.forEach((request) => request.reject(reason));
    this.videoRequests = [];
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
  }

  private observe(subscription: ResultSubscription): void {
    this.state = subscription.state;
    const execution = `${subscription.jobId}/${subscription.state}/${subscription.executionGeneration}`;
    if (execution === this.execution) return;
    this.execution = execution;
    if (this.running) this.watching.now();
  }

  /** The job continues under a successor: leases and video move to it. */
  private follow(jobId: string): void {
    this.jobId = jobId;
    this.state = undefined;
    if (this.session) this.holding.now();
  }

  // Both clean up before the callback runs, so a callback that throws leaves nothing behind.
  private end(state: JobState): void {
    if (this.released) return;
    this.jobOver = true;
    // a job still being cancelled ends with whatever state it was in
    const reason = state === "completed" || state === "error" ? state : "cancelled";
    this.finish(new Error(`The job ended: ${reason}.`)).catch(() => undefined);
    this.callbacks.onEnd?.({ reason });
  }

  private fail(error: Error, keepalive = false): void {
    if (this.released) return;
    // a deployment keeps running until someone stops it, even when this browser cannot follow it
    if (this.ownsPreview) this.finish(error, keepalive).catch(() => undefined);
    else this.release(error);
    this.callbacks.onError?.(error);
  }

  /** A temporary preview's owner lease; `held: false` means this job is over. */
  private async renewHold(): Promise<number | undefined> {
    try {
      const { held } = await this.connector.request({
        operation: "holdPreview",
        jobId: this.jobId
      });
      return held ? RENEW_MS : undefined;
    } catch (error) {
      if (retryable(error)) return RETRY_MS;
      this.fail(asError(error));
      return undefined;
    }
  }

  /** The watch lease, while the video plays or it keeps a registered preview alive. */
  private async renewWatch(): Promise<number | undefined> {
    if ((!this.player && !this.keepsAliveByWatching) || !this.running) return undefined;
    const { jobId, output } = this;
    const calls = this.videoCalls;
    try {
      const grant = await this.connector.request({ operation: "watch", jobId, output });
      if (this.released || jobId !== this.jobId) return undefined;
      this.grantedOutput = output;
      this.grantedCalls = calls;
      this.player?.play(grant.whepUrl, `${jobId}/${grant.executionGeneration}/${output}`);
      this.settleVideo();
      return RENEW_MS;
    } catch (error) {
      if (this.released) return undefined;
      if (retryable(error)) return RETRY_MS;
      // a 400 refuses the output (or races the job leaving "running"); anything else refuses the
      // lease a registered preview lives on
      if (
        this.keepsAliveByWatching &&
        !(error instanceof StreamingApiError && error.status === 400)
      ) {
        this.fail(asError(error));
        return undefined;
      }
      this.refuseVideo(asError(error), calls, output);
      return RENEW_MS;
    }
  }

  /** Resolves the `remoteStream` calls a watch covered, once video plays. */
  private settleVideo(): void {
    if (!this.playing || !this.player) return;
    const { stream } = this.player;
    this.videoRequests = this.videoRequests.filter((request) => {
      if (request.call > this.grantedCalls) return true;
      request.resolve(stream);
      return false;
    });
  }

  /** The platform refused a watch: the calls it covered reject and the selection stays as it was. */
  private refuseVideo(error: Error, calls: number, output: string | undefined): void {
    this.videoRequests = this.videoRequests.filter((request) => {
      if (request.call <= this.grantedCalls || request.call > calls) return true;
      request.reject(error);
      return false;
    });
    if (this.output === output) this.output = this.grantedOutput;
    if (!this.playing && this.videoRequests.length === 0) {
      this.player?.close();
      this.player = undefined;
    }
  }
}
