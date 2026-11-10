import {
  StreamingApi,
  StreamingApiError,
  type JobRequest,
  type StreamingApiOptions,
  type StreamingOperation,
  type StreamingRequest
} from "./api";

export interface StreamingProxyOptions extends StreamingApiOptions {
  /**
   * Decides whether to run a validated request, for example whether the signed-in user may use
   * that source, job or Workflow. Refused requests answer 403.
   */
  authorize?: (request: StreamingRequest) => boolean | Promise<boolean>;
}

export interface StreamingProxyResponse {
  status: number;
  body: unknown;
}

/**
 * The server side of `connectors.withProxyUrl`: give it the parsed JSON body of each POST and send
 * back the status and body it returns. Anything but one of the SDK's operations, exactly as the
 * SDK sends it, is refused with 400; watch grants come back without the processor token and RTSPS
 * URL.
 *
 * Without `authorize`, anyone who can reach the endpoint can use every source and job in your
 * workspace with your key.
 *
 * @example
 * ```typescript
 * const handle = createStreamingProxy({ apiKey: process.env.ROBOFLOW_API_KEY! });
 * app.post("/api/streaming", async (req, res) => {
 *   const { status, body } = await handle(req.body);
 *   res.status(status).json(body);
 * });
 * ```
 */
export function createStreamingProxy({
  authorize,
  ...apiOptions
}: StreamingProxyOptions): (body: unknown) => Promise<StreamingProxyResponse> {
  const api = new StreamingApi(apiOptions);
  return async (body) => {
    const problem = invalidRequest(body);
    if (problem) return { status: 400, body: { error: problem } };
    const request = body as StreamingRequest;
    if (authorize && !(await authorize(request))) {
      return { status: 403, body: { error: "This request is not allowed." } };
    }
    try {
      return { status: 200, body: await api.request(request) };
    } catch (error) {
      if (error instanceof StreamingApiError) {
        return { status: error.status, body: { error: error.message } };
      }
      return { status: 502, body: { error: "The Cloud Streaming API could not be reached." } };
    }
  };
}

type Check = (value: unknown) => boolean;

const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
const text: Check = (value) => typeof value === "string" && value.length > 0;
const object: Check = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive: Check = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
// Ids become URL path segments.
const id: Check = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[/\\]/.test(value) &&
  value !== "." &&
  value !== "..";
const idempotencyKey: Check = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);

const JOB_FIELDS: Record<keyof JobRequest, Check> = {
  workflowUrl: optional(text),
  workflowSpecification: optional(object),
  workflowParameters: optional(object),
  imageOutput: optional(text),
  maxFps: optional(positive),
  processorSize: optional(oneOf("gpu-s-v1", "gpu-m-v1", "gpu-l-v1", "cpu-standard-v1")),
  tier: optional(oneOf("gpu", "cpu")),
  // required: the API would make an omitted purpose a deployment, past an `authorize` that
  // only checks for "deployment"
  purpose: oneOf("preview", "deployment")
};

const job: Check = (value) =>
  object(value) &&
  !fieldProblem(value as Record<string, unknown>, JOB_FIELDS) &&
  ((value as JobRequest).workflowUrl === undefined) !==
    ((value as JobRequest).workflowSpecification === undefined);

const REQUEST_FIELDS: Record<StreamingOperation, Record<string, Check>> = {
  listSources: {},
  createSession: { name: optional(text), idempotencyKey },
  startJob: { sourceId: id, idempotencyKey, job },
  getJob: { jobId: id },
  holdPreview: { jobId: id },
  watch: { jobId: id, output: optional(text) },
  subscribeResults: { jobId: id },
  cancelJob: { jobId: id },
  stopSession: { sourceId: id }
};

/** Why `body` is not exactly one of the SDK's requests, or undefined when it is. */
function invalidRequest(body: unknown): string | undefined {
  if (!object(body)) return "The request must be a JSON object.";
  const { operation, ...fields } = body as Record<string, unknown>;
  if (
    typeof operation !== "string" ||
    !Object.prototype.hasOwnProperty.call(REQUEST_FIELDS, operation)
  ) {
    return "Unknown operation.";
  }
  const problem = fieldProblem(fields, REQUEST_FIELDS[operation as StreamingOperation]);
  return problem && `Invalid ${operation} request: ${problem}`;
}

function fieldProblem(
  fields: Record<string, unknown>,
  checks: Record<string, Check>
): string | undefined {
  const unknown = Object.keys(fields).find(
    (name) => !Object.prototype.hasOwnProperty.call(checks, name)
  );
  if (unknown !== undefined) return `unknown field "${unknown}"`;
  const invalid = Object.keys(checks).find((name) => !checks[name](fields[name]));
  return invalid === undefined ? undefined : `invalid "${invalid}"`;
}
