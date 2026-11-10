import { afterEach, describe, expect, it, vi } from "vitest";
import { retryable, StreamingApi, StreamingApiError } from "./api";

function respond(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StreamingApi errors", () => {
  it.each([
    ['{"error":"job is not running"}', "job is not running"],
    [
      '{"error":{"message":"Out of credits","type":"UsageError","hint":"Upgrade"}}',
      "Out of credits"
    ],
    ["<html>Bad Gateway</html>", "Request failed with status 502"]
  ])("reads %s", async (body, message) => {
    vi.stubGlobal("fetch", respond(502, body));
    const api = new StreamingApi({ apiKey: "key", workspace: "acme" });

    const error = await api.getJob({ jobId: "job" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StreamingApiError);
    expect(error).toMatchObject({ status: 502, message });
  });
});

describe("StreamingApi workspace", () => {
  it("looks the workspace up from the key once", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(url.endsWith(".com/") ? { workspace: "acme" } : { job: { id: "job" } })
    );
    vi.stubGlobal("fetch", fetch);
    const api = new StreamingApi({ apiKey: "key" });

    await api.getJob({ jobId: "a" });
    await api.getJob({ jobId: "b" });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.roboflow.com/",
      "https://api.roboflow.com/acme/video-jobs/v1/a",
      "https://api.roboflow.com/acme/video-jobs/v1/b"
    ]);
  });
});

describe("retryable", () => {
  it.each([
    [new TypeError("Failed to fetch"), true],
    [new DOMException("timed out", "TimeoutError"), true],
    [new StreamingApiError(408, ""), true],
    [new StreamingApiError(429, ""), true],
    [new StreamingApiError(503, ""), true],
    [new StreamingApiError(400, ""), false],
    [new StreamingApiError(404, ""), false],
    [new StreamingApiError(409, ""), false],
    [new Error("The video relay named no WHIP session."), false]
  ])("%s → %s", (error, expected) => {
    expect(retryable(error)).toBe(expected);
  });
});
