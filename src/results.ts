import { asError, retryable, type Connector, type JobState, type ResultSubscription } from "./api";

/** One processed frame's Workflow outputs. */
export interface StreamResult {
  /** Counts results within one execution; restarts at 0 when the job runs again elsewhere. */
  seq: number;
  frameId: number;
  /** When the result was published (ISO 8601 UTC), not when the frame was captured. */
  timestamp: string;
  latencyMs: number;
  /** Top-level image outputs arrive as `{ type: "image_ref", output: "<name>" }`. */
  outputs: Record<string, unknown>;
  executionGeneration?: number;
}

/** Results `fromSeq` through `toSeq` (inclusive) were not delivered. */
export interface ResultGap {
  fromSeq: number;
  toSeq: number;
}

type FeedMessage =
  | { type: "hello"; executionGeneration?: number }
  | {
      type: "result";
      seq: number;
      result: {
        frameId: number;
        timestamp: string;
        latencyMs: number;
        outputs: Record<string, unknown>;
      };
    }
  | ({ type: "gap" } & ResultGap)
  | { type: "end"; reason: string };

export interface ResultsFeedOptions {
  connector: Connector;
  jobId: string;
  onResult?: (result: StreamResult) => void;
  onGap?: (gap: ResultGap) => void;
  /** Every live answer of the subscription: the job's state while it has not ended. */
  onSubscription: (subscription: ResultSubscription) => void;
  /** The job continues under another id; the feed follows it. */
  onSuccessor: (jobId: string) => void;
  /** The job will produce no more results. */
  onEnd: (state: JobState) => void;
  onError: (error: Error) => void;
  /** The WebSocket implementation; the global one by default. */
  WebSocket?: typeof WebSocket;
}

const SUBSCRIBE_RETRY_MS = 2_000;
const CONNECT_INTERVAL_MS = 1_000;
// A browser cannot see why an upgrade was refused (401, 404, 429...), so every refusal counts the
// same; from the second one on, waits respect the 5 s minimum a 429 asks for.
const REFUSAL_DELAYS_MS = [1_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Reads a job's results until it ends: subscribe, follow successors, wait out `retryAfterSeconds`,
 * read the feed with an `after` cursor (reset when the execution changes), and subscribe again
 * after every closed or refused connection. Returns a function that stops it; no callback runs
 * after that.
 */
export function followResults(options: ResultsFeedOptions): () => void {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  let jobId = options.jobId;
  let generation: number | undefined;
  let cursor: number | undefined;
  let refusals = 0;
  let stopped = false;
  let socket: WebSocket | undefined;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function subscribe(): Promise<ResultSubscription | undefined> {
    for (;;) {
      try {
        return await options.connector.request({ operation: "subscribeResults", jobId });
      } catch (error) {
        if (stopped) return undefined;
        if (!retryable(error)) {
          options.onError(asError(error));
          return undefined;
        }
      }
      await sleep(SUBSCRIBE_RETRY_MS);
      if (stopped) return undefined;
    }
  }

  /** Reads one connection until it closes; true when it opened. */
  function read(eventsUrl: string, accessToken: string): Promise<boolean> {
    const url = new URL(eventsUrl);
    url.searchParams.set("access_token", accessToken);
    if (cursor !== undefined) url.searchParams.set("after", String(cursor));
    return new Promise((resolve) => {
      let opened = false;
      const connection = new Socket(url.toString());
      socket = connection;
      connection.onopen = () => {
        opened = true;
      };
      connection.onclose = () => {
        socket = undefined;
        resolve(opened);
      };
      connection.onmessage = (event: MessageEvent) => {
        let message: FeedMessage;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        switch (message.type) {
          case "hello":
            if (message.executionGeneration !== generation) {
              generation = message.executionGeneration;
              const replaying = cursor !== undefined;
              cursor = undefined;
              // the cursor named a seq of another execution: read this one from its start
              if (replaying) connection.close();
            }
            break;
          case "result":
            cursor = message.seq;
            options.onResult?.({
              seq: message.seq,
              frameId: message.result.frameId,
              timestamp: message.result.timestamp,
              latencyMs: message.result.latencyMs,
              outputs: message.result.outputs,
              executionGeneration: generation
            });
            break;
          case "gap":
            cursor = Math.max(cursor ?? -1, message.toSeq);
            options.onGap?.({ fromSeq: message.fromSeq, toSeq: message.toSeq });
            break;
          case "end":
            // only a courtesy: the subscription says whether the job ended or moved
            connection.close();
            break;
        }
      };
    });
  }

  async function run(): Promise<void> {
    while (!stopped) {
      const subscription = await subscribe();
      if (stopped || !subscription) return;
      if (subscription.ended) {
        if (!subscription.successorJobId) {
          options.onEnd(subscription.state);
          return;
        }
        jobId = subscription.successorJobId;
        generation = undefined;
        cursor = undefined;
        refusals = 0;
        options.onSuccessor(jobId);
        continue;
      }
      options.onSubscription(subscription);
      const { eventsUrl, accessToken, retryAfterSeconds = 2 } = subscription;
      if (!eventsUrl || !accessToken) {
        await sleep(retryAfterSeconds * 1000);
        continue;
      }
      if (subscription.executionGeneration !== generation) {
        generation = subscription.executionGeneration;
        cursor = undefined;
      }
      const connectedAt = Date.now();
      const opened = await read(eventsUrl, accessToken);
      if (stopped) return;
      refusals = opened ? 0 : refusals + 1;
      const interval = opened
        ? CONNECT_INTERVAL_MS
        : REFUSAL_DELAYS_MS[Math.min(refusals, REFUSAL_DELAYS_MS.length) - 1];
      await sleep(connectedAt + interval - Date.now());
    }
  }

  run().catch((error: unknown) => {
    // once stopped, an error is a callback's own: let it surface
    if (stopped) throw error;
    options.onError(asError(error));
  });
  return () => {
    stopped = true;
    wake?.();
    socket?.close();
  };
}
