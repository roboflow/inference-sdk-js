import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingProxy } from "./proxy";

const workflow = { workflowUrl: "detect-people", purpose: "preview" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createStreamingProxy", () => {
  it.each([
    ["a non-object", "subscribeResults"],
    ["an unknown operation", { operation: "deleteSource", sourceId: "src" }],
    ["an inherited name", { operation: "toString" }],
    ["an unknown field", { operation: "getJob", jobId: "job", workspace: "other" }],
    ["a missing field", { operation: "cancelJob" }],
    ["an id that leaves its path segment", { operation: "cancelJob", jobId: ".." }],
    [
      "an unknown job field",
      {
        operation: "startJob",
        sourceId: "src",
        idempotencyKey: "0f6a0a6c-key",
        job: { ...workflow, recoveryPolicy: "always" }
      }
    ],
    [
      "a job without a purpose, which the API would make a deployment",
      {
        operation: "startJob",
        sourceId: "src",
        idempotencyKey: "0f6a0a6c-key",
        job: { workflowUrl: "detect-people" }
      }
    ],
    [
      "two workflows",
      {
        operation: "startJob",
        sourceId: "src",
        idempotencyKey: "0f6a0a6c-key",
        job: { ...workflow, workflowSpecification: {} }
      }
    ],
    [
      "a malformed idempotency key",
      {
        operation: "createSession",
        idempotencyKey: "short"
      }
    ]
  ])("refuses %s with 400 without calling Roboflow", async (_, body) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handle = createStreamingProxy({ apiKey: "key", workspace: "acme" });

    const response = await handle(body);

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands browsers a watch grant without the processor token or RTSPS URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          watch: { requestedUntil: 1, output: null },
          executionGeneration: 3,
          whepUrl: "https://relay.test/out/whep?key=k",
          rtspsUrl: "rtsps://out:k@relay.test:8322/out",
          processorAccessToken: "secret"
        })
      )
    );
    const handle = createStreamingProxy({ apiKey: "key", workspace: "acme" });

    const response = await handle({ operation: "watch", jobId: "job" });

    expect(response).toEqual({
      status: 200,
      body: {
        watch: { requestedUntil: 1, output: null },
        executionGeneration: 3,
        whepUrl: "https://relay.test/out/whep?key=k"
      }
    });
  });

  it("refuses what authorize refuses with 403 without calling Roboflow", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handle = createStreamingProxy({
      apiKey: "key",
      workspace: "acme",
      authorize: async (request) =>
        request.operation !== "startJob" || request.job.purpose !== "deployment"
    });

    const response = await handle({
      operation: "startJob",
      sourceId: "src",
      idempotencyKey: "0f6a0a6c-key",
      job: { ...workflow, purpose: "deployment" }
    });

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes Roboflow's refusal through with its status and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "resource not found" }, { status: 404 }))
    );
    const handle = createStreamingProxy({ apiKey: "key", workspace: "acme" });

    const response = await handle({ operation: "getJob", jobId: "job" });

    expect(response).toEqual({ status: 404, body: { error: "resource not found" } });
  });
});
