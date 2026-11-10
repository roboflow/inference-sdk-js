import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StreamingApiError,
  type Connector,
  type RequestOptions,
  type ResultSubscription,
  type StreamingRequest
} from "./api";
import { attachStream, startStream } from "./stream";

type Sent = { request: StreamingRequest; keepalive?: boolean };

type Operation = StreamingRequest["operation"];

/** Roboflow's side: jobs run as soon as they start and never offer a feed. */
function platform(
  subscription: Partial<ResultSubscription> | Error = { state: "running" },
  refusals: Partial<Record<Operation, StreamingApiError[]>> = {}
) {
  const sent: Sent[] = [];
  let jobs = 0;
  const connector = {
    request: async (request: StreamingRequest, options?: RequestOptions) => {
      sent.push({ request, keepalive: options?.keepalive });
      const refusal = refusals[request.operation]?.shift();
      if (refusal) throw refusal;
      switch (request.operation) {
        case "startJob":
          jobs += 1;
          return {
            job: {
              id: `job-${jobs}`,
              sourceId: request.sourceId,
              state: "queued",
              purpose: request.job.purpose
            }
          };
        case "getJob":
          return {
            job: { id: request.jobId, sourceId: "camera", state: "running", purpose: "preview" }
          };
        case "subscribeResults":
          if (subscription instanceof Error) throw subscription;
          return { jobId: request.jobId, ended: false, retryAfterSeconds: 3600, ...subscription };
        case "watch":
          return { watch: { requestedUntil: 0, output: null }, whepUrl: "https://relay.test/whep" };
        default:
          return {};
      }
    }
  } as Connector;
  const operations = (operation: Operation) =>
    sent.filter((entry) => entry.request.operation === operation);
  return { connector, sent, operations };
}

const start = (
  connector: Connector,
  purpose: "preview" | "deployment" = "preview",
  callbacks = {}
) => startStream({ connector, source: "camera", workflow: "detect-people", purpose, ...callbacks });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stop", () => {
  it("cancels the job the stream started, once", async () => {
    const { connector, operations } = platform();
    const stream = await start(connector, "deployment");

    await Promise.all([stream.stop(), stream.stop()]);
    await stream.stop();

    expect(operations("cancelJob").map(({ request }) => request)).toEqual([
      { operation: "cancelJob", jobId: "job-1" }
    ]);
  });

  it("sends a cancel that failed again on the next call", async () => {
    const { connector, operations } = platform(undefined, {
      cancelJob: [new StreamingApiError(403, "forbidden")]
    });
    const stream = await start(connector, "deployment");

    await expect(stream.stop()).rejects.toMatchObject({ status: 403 });
    await stream.stop();

    expect(operations("cancelJob")).toHaveLength(2);
  });

  it("never cancels an attached job", async () => {
    const { connector, operations } = platform();
    const stream = await attachStream({ connector, jobId: "someone-elses" });

    await stream.stop();

    expect(operations("cancelJob")).toEqual([]);
    expect(operations("stopSession")).toEqual([]);
  });

  it("does not cancel a job that ended by itself", async () => {
    const { connector, operations } = platform({ ended: true, state: "completed" });
    const onEnd = vi.fn();
    const stream = await start(connector, "preview", { onEnd });
    await vi.advanceTimersByTimeAsync(0);

    await stream.stop();

    expect(onEnd).toHaveBeenCalledWith({ reason: "completed" });
    expect(operations("cancelJob")).toEqual([]);
  });
});

describe("keep-alive", () => {
  it("renews a registered-source preview's watch every 30 s; a deployment needs none", async () => {
    const preview = platform();
    const deployment = platform();
    await start(preview.connector, "preview");
    await start(deployment.connector, "deployment");

    await vi.advanceTimersByTimeAsync(60_000);

    expect(preview.operations("watch")).toHaveLength(3);
    expect(deployment.operations("watch")).toEqual([]);
  });
});

describe("leaving the page", () => {
  it("stops a preview with keepalive requests and leaves a deployment running", async () => {
    vi.stubGlobal("window", new EventTarget());
    const preview = platform();
    const deployment = platform();
    await start(preview.connector, "preview");
    await start(deployment.connector, "deployment");

    window.dispatchEvent(new Event("pagehide"));

    expect(preview.operations("cancelJob")).toEqual([
      { request: { operation: "cancelJob", jobId: "job-1" }, keepalive: true }
    ]);
    expect(deployment.operations("cancelJob")).toEqual([]);
  });
});

describe("failure", () => {
  it("fails a registered-source preview whose watch lease is refused", async () => {
    const { connector, operations } = platform(undefined, {
      watch: [new StreamingApiError(403, "forbidden")]
    });
    const onError = vi.fn();
    await start(connector, "preview", { onError });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(operations("cancelJob")).toHaveLength(1);
  });

  it("reports the error, cancels a preview and leaves a deployment running", async () => {
    const preview = platform(new StreamingApiError(403, "forbidden"));
    const deployment = platform(new StreamingApiError(403, "forbidden"));
    const previewError = vi.fn();
    const deploymentError = vi.fn();
    await start(preview.connector, "preview", { onError: previewError });
    await start(deployment.connector, "deployment", { onError: deploymentError });
    await vi.advanceTimersByTimeAsync(0);

    expect(previewError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deploymentError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(preview.operations("cancelJob")).toHaveLength(1);
    expect(deployment.operations("cancelJob")).toEqual([]);
  });
});
