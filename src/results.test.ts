import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StreamingApiError,
  type Connector,
  type ResultSubscription,
  type StreamingRequest
} from "./api";
import { followResults, type ResultGap, type StreamResult } from "./results";

class FakeSocket {
  static sockets: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  readonly url: URL;

  constructor(url: string) {
    this.url = new URL(url);
    FakeSocket.sockets.push(this);
  }

  open(...messages: object[]) {
    this.onopen?.();
    messages.forEach((message) => this.send(message));
  }

  send(message: object) {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
}

const feed = (executionGeneration = 1): Partial<ResultSubscription> => ({
  executionGeneration,
  eventsUrl: "wss://processor.test/events/ws?job=job",
  accessToken: "results-token"
});
const result = (seq: number) => ({
  type: "result",
  seq,
  result: { frameId: seq, timestamp: "2026-11-10T12:00:00Z", latencyMs: 40, outputs: {} }
});

function follow(...answers: Array<Partial<ResultSubscription> | Error>) {
  const subscribed: string[] = [];
  const results: StreamResult[] = [];
  const gaps: ResultGap[] = [];
  const events: string[] = [];
  const connector = {
    request: async (request: StreamingRequest) => {
      if (request.operation !== "subscribeResults") throw new Error(request.operation);
      subscribed.push(request.jobId);
      const answer = answers.shift() ?? { retryAfterSeconds: 3600 };
      if (answer instanceof Error) throw answer;
      return { jobId: request.jobId, state: "running", ended: false, ...answer };
    }
  } as Connector;
  const stop = followResults({
    connector,
    jobId: "job",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    onResult: (delivered) => results.push(delivered),
    onGap: (gap) => gaps.push(gap),
    onSubscription: () => undefined,
    onSuccessor: (jobId) => events.push(`successor ${jobId}`),
    onEnd: (state) => events.push(`end ${state}`),
    onError: (error) => events.push(`error ${error.message}`)
  });
  return { subscribed, results, gaps, events, stop };
}

const socket = (index: number) => FakeSocket.sockets[index];
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.sockets = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("followResults", () => {
  it("reads the feed with its token and resumes after the last result", async () => {
    const feedState = follow(feed(), feed());
    await flush();
    expect(socket(0).url.searchParams.get("access_token")).toBe("results-token");
    expect(socket(0).url.searchParams.has("after")).toBe(false);

    socket(0).open({ type: "hello", executionGeneration: 1 }, result(0), result(1));
    socket(0).close();
    await flush(1_000);

    expect(
      feedState.results.map(({ seq, executionGeneration }) => [seq, executionGeneration])
    ).toEqual([
      [0, 1],
      [1, 1]
    ]);
    expect(socket(1).url.searchParams.get("after")).toBe("1");
  });

  it("starts a new execution from its beginning", async () => {
    follow(feed(1), feed(2));
    await flush();
    socket(0).open({ type: "hello", executionGeneration: 1 }, result(5));
    socket(0).close();
    await flush(1_000);

    expect(socket(1).url.searchParams.has("after")).toBe(false);
  });

  it("drops a cursor the processor's hello shows belongs to another execution", async () => {
    follow(feed(1), feed(1), feed(2));
    await flush();
    socket(0).open({ type: "hello", executionGeneration: 1 }, result(4));
    socket(0).close();
    await flush(1_000);
    expect(socket(1).url.searchParams.get("after")).toBe("4");

    socket(1).open({ type: "hello", executionGeneration: 2 });
    await flush(1_000);

    expect(socket(1).closed).toBe(true);
    expect(socket(2).url.searchParams.has("after")).toBe(false);
  });

  it("surfaces a gap and does not ask for it again", async () => {
    const feedState = follow(feed(), feed());
    await flush();
    socket(0).open({ type: "hello", executionGeneration: 1 }, result(3), {
      type: "gap",
      fromSeq: 4,
      toSeq: 9
    });
    socket(0).close();
    await flush(1_000);

    expect(feedState.gaps).toEqual([{ fromSeq: 4, toSeq: 9 }]);
    expect(socket(1).url.searchParams.get("after")).toBe("9");
  });

  it("asks the subscription after an end message, and ends with the job", async () => {
    const feedState = follow(feed(), { ended: true, state: "completed" });
    await flush();
    socket(0).open({ type: "hello", executionGeneration: 1 }, { type: "end", reason: "completed" });
    await flush(1_000);

    expect(feedState.subscribed).toHaveLength(2);
    expect(feedState.events).toEqual(["end completed"]);
    expect(FakeSocket.sockets).toHaveLength(1);
  });

  it("follows a successor job from its first result", async () => {
    const feedState = follow(
      feed(),
      { ended: true, state: "error", successorJobId: "successor" },
      feed(1)
    );
    await flush();
    socket(0).open({ type: "hello", executionGeneration: 1 }, result(7));
    socket(0).close();
    await flush(1_000);

    expect(feedState.events).toEqual(["successor successor"]);
    expect(feedState.subscribed).toEqual(["job", "job", "successor"]);
    expect(socket(1).url.searchParams.has("after")).toBe(false);
  });

  it("waits retryAfterSeconds before asking again", async () => {
    const feedState = follow({ retryAfterSeconds: 60 }, feed());
    await flush(59_999);
    expect(feedState.subscribed).toHaveLength(1);

    await flush(1);
    expect(feedState.subscribed).toHaveLength(2);
    expect(FakeSocket.sockets).toHaveLength(1);
  });

  it("backs off refused connections and recovers once one opens", async () => {
    follow(feed(), feed(), feed(), feed(), feed());
    const attempts: number[] = [];
    const refuseNext = async (wait: number) => {
      socket(FakeSocket.sockets.length - 1).close();
      await flush(wait - 1);
      attempts.push(FakeSocket.sockets.length);
      await flush(1);
    };
    await flush();

    await refuseNext(1_000);
    await refuseNext(5_000);
    await refuseNext(10_000);
    socket(3).open({ type: "hello", executionGeneration: 1 });
    socket(3).close();
    await flush(1_000);

    // one short of each wait, no new attempt had started yet
    expect(attempts).toEqual([1, 2, 3]);
    expect(FakeSocket.sockets).toHaveLength(5);
  });

  it("retries a lost or failed subscription after two seconds", async () => {
    const feedState = follow(
      new TypeError("Failed to fetch"),
      new StreamingApiError(503, "unavailable"),
      feed()
    );
    await flush(1_999);
    expect(feedState.subscribed).toHaveLength(1);

    await flush(1 + 2_000);
    expect(feedState.subscribed).toHaveLength(3);
    expect(FakeSocket.sockets).toHaveLength(1);
  });

  it("fails on a refused subscription", async () => {
    const feedState = follow(new StreamingApiError(400, "bad request"), feed());
    await flush(60_000);

    expect(feedState.events).toEqual(["error bad request"]);
    expect(feedState.subscribed).toHaveLength(1);
  });

  it("delivers nothing after it is stopped", async () => {
    const feedState = follow(feed(), { ended: true, state: "completed" });
    await flush();
    socket(0).open({ type: "hello", executionGeneration: 1 });
    feedState.stop();
    socket(0).send(result(0));
    await flush(60_000);

    expect(feedState.results).toEqual([]);
    expect(feedState.events).toEqual([]);
    expect(feedState.subscribed).toHaveLength(1);
  });
});
