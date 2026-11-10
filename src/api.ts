/**
 * The Cloud Streaming v1 API: the operations the SDK uses, their responses, the REST client that
 * runs them with an API key, and the one error type they raise.
 */

export const DEFAULT_API_URL = "https://api.roboflow.com";
/** A request that hangs must not hold up the renewal it belongs to. */
export const REQUEST_TIMEOUT_MS = 15_000;

export type ProcessorSize = "gpu-s-v1" | "gpu-m-v1" | "gpu-l-v1" | "cpu-standard-v1";

/** The v1 job body fields the SDK sends when it starts a job. */
export interface JobRequest {
  /** A saved Workflow; exactly one of this and `workflowSpecification`. */
  workflowUrl?: string;
  workflowSpecification?: Record<string, unknown>;
  workflowParameters?: Record<string, unknown>;
  imageOutput?: string;
  maxFps?: number;
  processorSize?: ProcessorSize;
  tier?: "gpu" | "cpu";
  /** Always sent: the API would make an omitted purpose a deployment on a registered source. */
  purpose: "preview" | "deployment";
}

/** One Cloud Streaming operation, as a browser sends it to a proxy. */
export type StreamingRequest =
  | { operation: "listSources" }
  | { operation: "createSession"; name?: string; idempotencyKey: string }
  | { operation: "startJob"; sourceId: string; idempotencyKey: string; job: JobRequest }
  | { operation: "getJob"; jobId: string }
  | { operation: "holdPreview"; jobId: string }
  | { operation: "watch"; jobId: string; output?: string }
  | { operation: "subscribeResults"; jobId: string }
  | { operation: "cancelJob"; jobId: string }
  | { operation: "stopSession"; sourceId: string };

export type StreamingOperation = StreamingRequest["operation"];

export type JobState =
  "queued" | "claimed" | "running" | "waiting" | "blocked" | "completed" | "error" | "cancelled";

/** A video source as the API lists it; it never carries stream credentials. */
export interface VideoSource {
  id: string;
  name: string;
  kind: string;
  status: string;
  [field: string]: unknown;
}

/** A job's public record; it never carries credentials. */
export interface VideoJob {
  id: string;
  sourceId: string;
  state: JobState;
  purpose: "preview" | "deployment";
  successorJobId?: string | null;
  [field: string]: unknown;
}

/** A temporary source a browser publishes into; `whipUrl` carries its publish credential. */
export interface TemporarySession {
  source: VideoSource;
  sourceId: string;
  grantExpiresAt: number;
  whipUrl: string;
}

/** What a browser needs to play a job's annotated output; `whepUrl` carries a credential. */
export interface WatchGrant {
  watch: { requestedUntil: number; output: string | null };
  executionGeneration?: number;
  whepUrl: string;
}

/**
 * Where to read a job's results: `ended` (following `successorJobId` when the job continues under
 * another id), `retryAfterSeconds`, or a feed (`eventsUrl` and its `accessToken`).
 */
export interface ResultSubscription {
  jobId: string;
  state: JobState;
  ended: boolean;
  executionGeneration?: number;
  successorJobId?: string;
  retryAfterSeconds?: number;
  eventsUrl?: string;
  pollUrl?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

export interface StreamingResponses {
  listSources: { sources: VideoSource[]; webcamAvailable: boolean };
  createSession: TemporarySession;
  startJob: { job: VideoJob };
  getJob: { job: VideoJob };
  holdPreview: { held: boolean };
  watch: WatchGrant;
  subscribeResults: ResultSubscription;
  cancelJob: { job: VideoJob };
  stopSession: { source: VideoSource; stopRequested: true };
}

export type StreamingResponse<R extends StreamingRequest> = StreamingResponses[R["operation"]];

export interface RequestOptions {
  /** Lets the request outlive the page, for cleanup on `pagehide`. */
  keepalive?: boolean;
}

/** How the browser reaches the Cloud Streaming API: directly with a key, or through your backend. */
export interface Connector {
  request<R extends StreamingRequest>(
    request: R,
    options?: RequestOptions
  ): Promise<StreamingResponse<R>>;
}

/** A refusal from the Cloud Streaming API (or the video relay), with its HTTP status. */
export class StreamingApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StreamingApiError";
    this.status = status;
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A lost request, a timeout or a server-side failure, worth retrying; any other refusal is final. */
export function retryable(error: unknown): boolean {
  if (error instanceof StreamingApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")
  );
}

/** Reads `{ error: string }` or `{ error: { message } }` from a failed response. */
export async function errorFromResponse(response: Response): Promise<StreamingApiError> {
  const body: unknown = await response.json().catch(() => null);
  return new StreamingApiError(
    response.status,
    errorMessage(body) ?? `Request failed with status ${response.status}`
  );
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  const { error } = body;
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
}

export interface StreamingApiOptions {
  apiKey: string;
  /** The workspace slug; looked up from the key when omitted. */
  workspace?: string;
  /** Defaults to `https://api.roboflow.com` (staging: `https://api.roboflow.one`). */
  apiUrl?: string;
}

type CallOptions = RequestOptions & { body?: object; idempotencyKey?: string };

/**
 * The Cloud Streaming v1 REST client: one method per operation. It holds the API key, so it
 * belongs on a server (Node 18+ or an edge runtime); `connectors.withApiKey` uses it in the
 * browser for demos only.
 */
export class StreamingApi implements Connector {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private workspace: Promise<string> | undefined;

  constructor({ apiKey, workspace, apiUrl = DEFAULT_API_URL }: StreamingApiOptions) {
    if (!apiKey) throw new Error("apiKey is required");
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.workspace = workspace ? Promise.resolve(workspace) : undefined;
  }

  /**
   * Runs one operation and answers what a browser may see: a watch grant without its processor
   * token and RTSPS URL.
   */
  request<R extends StreamingRequest>(
    request: R,
    options?: RequestOptions
  ): Promise<StreamingResponse<R>> {
    return this.dispatch(request, options) as Promise<StreamingResponse<R>>;
  }

  private async dispatch(request: StreamingRequest, options?: RequestOptions) {
    switch (request.operation) {
      case "listSources":
        return this.listSources(options);
      case "createSession":
        return this.createSession(request, options);
      case "startJob":
        return this.startJob(request, options);
      case "getJob":
        return this.getJob(request, options);
      case "holdPreview":
        return this.holdPreview(request, options);
      case "watch": {
        const { watch, executionGeneration, whepUrl } = await this.watch(request, options);
        return { watch, executionGeneration, whepUrl };
      }
      case "subscribeResults":
        return this.subscribeResults(request, options);
      case "cancelJob":
        return this.cancelJob(request, options);
      case "stopSession":
        return this.stopSession(request, options);
    }
  }

  listSources(options?: RequestOptions): Promise<StreamingResponses["listSources"]> {
    return this.call("GET", "/video-sources/v1", options);
  }

  /** Allocates a temporary source to publish into over WHIP. */
  createSession(
    { name, idempotencyKey }: { name?: string; idempotencyKey: string },
    options?: RequestOptions
  ): Promise<TemporarySession> {
    return this.call("POST", "/video-sources/v1/temporary", {
      ...options,
      body: name === undefined ? {} : { name },
      idempotencyKey
    });
  }

  startJob(
    {
      sourceId,
      idempotencyKey,
      job
    }: { sourceId: string; idempotencyKey: string; job: JobRequest },
    options?: RequestOptions
  ): Promise<{ job: VideoJob }> {
    return this.call("POST", `/video-sources/v1/${encodeURIComponent(sourceId)}/jobs`, {
      ...options,
      body: job,
      idempotencyKey
    });
  }

  getJob({ jobId }: { jobId: string }, options?: RequestOptions): Promise<{ job: VideoJob }> {
    return this.call("GET", `/video-jobs/v1/${encodeURIComponent(jobId)}`, options);
  }

  /** Renews a temporary preview's owner lease; `held: false` means the job is over. */
  holdPreview({ jobId }: { jobId: string }, options?: RequestOptions): Promise<{ held: boolean }> {
    return this.call("POST", `/video-jobs/v1/${encodeURIComponent(jobId)}/hold-preview`, {
      ...options,
      body: {}
    });
  }

  /** Requests the job's annotated output for at least 60 seconds; renew every 30 seconds. */
  watch(
    { jobId, output }: { jobId: string; output?: string },
    options?: RequestOptions
  ): Promise<WatchGrant & { rtspsUrl: string | null; processorAccessToken: string }> {
    return this.call("POST", `/video-jobs/v1/${encodeURIComponent(jobId)}/watch`, {
      ...options,
      body: output === undefined ? {} : { output }
    });
  }

  subscribeResults(
    { jobId }: { jobId: string },
    options?: RequestOptions
  ): Promise<ResultSubscription> {
    return this.call("POST", `/video-jobs/v1/${encodeURIComponent(jobId)}/results/subscribe`, {
      ...options,
      body: {}
    });
  }

  cancelJob({ jobId }: { jobId: string }, options?: RequestOptions): Promise<{ job: VideoJob }> {
    return this.call("POST", `/video-jobs/v1/${encodeURIComponent(jobId)}/cancel`, {
      ...options,
      body: {}
    });
  }

  /** Ends a temporary source's session and the jobs on it. */
  stopSession(
    { sourceId }: { sourceId: string },
    options?: RequestOptions
  ): Promise<StreamingResponses["stopSession"]> {
    return this.call("POST", `/video-sources/v1/${encodeURIComponent(sourceId)}/stop-session`, {
      ...options,
      body: {}
    });
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    { body, idempotencyKey, keepalive }: CallOptions = {}
  ): Promise<T> {
    const workspace = await this.resolveWorkspace();
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await fetch(`${this.apiUrl}/${encodeURIComponent(workspace)}${path}`, {
      method,
      headers,
      body: body && JSON.stringify(body),
      keepalive,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json();
  }

  private resolveWorkspace(): Promise<string> {
    this.workspace ??= this.lookUpWorkspace().catch((error: unknown) => {
      this.workspace = undefined;
      throw error;
    });
    return this.workspace;
  }

  private async lookUpWorkspace(): Promise<string> {
    const response = await fetch(`${this.apiUrl}/`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw await errorFromResponse(response);
    const { workspace } = await response.json();
    if (typeof workspace !== "string") {
      throw new StreamingApiError(401, "The API key names no workspace; pass `workspace`.");
    }
    return workspace;
  }
}
