import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RFWebRTCConnection, useVideoFile } from "./webrtc";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

function binaryMessage(frameId: number, data: unknown, gzip = false): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const payload = gzip ? gzipSync(json) : json;
  return chunkMessage(frameId, 0, 1, payload);
}

function chunkMessage(frameId: number, index: number, count: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + payload.length);
  const header = new DataView(buffer);
  header.setUint32(0, frameId, true);
  header.setUint32(4, index, true);
  header.setUint32(8, count, true);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

class MockDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  binaryType = "";
  send = vi.fn<(data: string) => void>();

  receive(data: ArrayBuffer | string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function setup(onData: (data: any) => void, ackPacingEnabled = true, onComplete?: () => void) {
  const channel = new MockDataChannel();
  const pc = { connectionState: "connected", close: vi.fn(() => channel.close()) };
  const connection = new RFWebRTCConnection(
    pc as unknown as RTCPeerConnection,
    new Promise<MediaStream>(() => {}), null, null,
    channel as unknown as RTCDataChannel,
    { onData, ackPacingEnabled, onComplete }
  );
  return { channel, connection, pc };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function delayDecompression(gate: ReturnType<typeof deferred>, data: unknown) {
  const started = deferred();
  vi.stubGlobal("DecompressionStream", class {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor() {
      const stream = new TransformStream<Uint8Array, Uint8Array>({
        async transform(_chunk, controller) {
          started.resolve();
          await gate.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(data)));
        }
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  });
  return started.promise;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("batch data channel ordering", () => {
  it("waits for earlier callbacks before delivering or ACKing a later frame", async () => {
    const first = deferred();
    const received: number[] = [];
    const { channel } = setup(async data => {
      received.push(data.id);
      if (data.id === 1) await first.promise;
    });

    channel.receive(binaryMessage(1, { id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await settle();
    const beforeRelease = { received: [...received], acks: [...channel.send.mock.calls] };
    first.resolve();
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(2));

    expect(beforeRelease).toEqual({ received: [1], acks: [] });
    expect(channel.send.mock.calls).toEqual([[JSON.stringify({ ack: 1 })], [JSON.stringify({ ack: 2 })]]);
  });

  it("delivers a gzip result before a following uncompressed completion message", async () => {
    const received: unknown[] = [];
    const { channel } = setup(data => { received.push(data); });
    channel.receive(binaryMessage(1, { result: "first" }, true));
    channel.receive(binaryMessage(2, { processing_complete: true }));

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([{ result: "first" }, { processing_complete: true }]);
    expect(channel.send.mock.calls).toEqual([[JSON.stringify({ ack: 1 })], [JSON.stringify({ ack: 2 })]]);
  });

  it("awaits legacy string callbacks in the same queue", async () => {
    const first = deferred();
    const received: number[] = [];
    const { channel } = setup(async data => {
      received.push(data.id);
      if (data.id === 1) await first.promise;
    });
    channel.receive(JSON.stringify({ id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await settle();
    const beforeRelease = { received: [...received], acks: [...channel.send.mock.calls] };
    first.resolve();
    await vi.waitFor(() => expect(received).toHaveLength(2));

    expect(beforeRelease).toEqual({ received: [1], acks: [] });
    expect(channel.send.mock.calls).toEqual([[JSON.stringify({ ack: 2 })]]);
  });

  it("drains received batch messages before onComplete when the remote channel closes", async () => {
    const first = deferred();
    const events: string[] = [];
    const { channel } = setup(async data => {
      if (data.id === 1) await first.promise;
      events.push(`data:${data.id}`);
    }, true, () => { events.push("close"); });
    channel.receive(binaryMessage(1, { id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    channel.close();
    await settle();
    const beforeRelease = [...events];
    first.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(3));

    expect(beforeRelease).toEqual([]);
    expect(events).toEqual(["data:1", "data:2", "close"]);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("keeps realtime callbacks concurrent without sending ACKs", async () => {
    const first = deferred();
    const received: number[] = [];
    const { channel } = setup(async data => {
      received.push(data.id);
      if (data.id === 1) await first.promise;
    }, false);
    channel.receive(binaryMessage(1, { id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await settle();
    expect(received).toEqual([1, 2]);
    expect(channel.send).not.toHaveBeenCalled();
    first.resolve();
  });

  it("reassembles chunked gzip and uses the completion transport ID for its ACK", async () => {
    const received: unknown[] = [];
    const { channel } = setup(data => { received.push(data); });
    const compressed = gzipSync(JSON.stringify({ id: 1 }));
    channel.receive(chunkMessage(1, 0, 2, compressed.subarray(0, 10)));
    await settle();
    expect(received).toEqual([]);
    expect(channel.send).not.toHaveBeenCalled();
    channel.receive(chunkMessage(1, 1, 2, compressed.subarray(10)));
    channel.receive(binaryMessage(2, { processing_complete: true, video_metadata: { frame_id: 1 } }));
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(2));
    expect(received).toEqual([{ id: 1 }, { processing_complete: true, video_metadata: { frame_id: 1 } }]);
    expect(channel.send.mock.calls).toEqual([[JSON.stringify({ ack: 1 })], [JSON.stringify({ ack: 2 })]]);
  });

  it.each(["binary", "string"])("stops after a rejected %s callback without ACKing queued work", async kind => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onComplete = vi.fn();
    const onData = vi.fn(async () => { throw new Error("consumer failure"); });
    const { channel, pc } = setup(onData, true, onComplete);
    channel.receive(kind === "binary" ? binaryMessage(1, { id: 1 }) : JSON.stringify({ id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledOnce());
    channel.receive(binaryMessage(3, { id: 3 }));
    expect(onData).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Batch data processing failed"), expect.any(Error));
  });

  it("preserves earlier successful ACKs but never ACKs past a later failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onData = vi.fn(data => { if (data.id === 2) throw new Error("failed second frame"); });
    const { channel, pc } = setup(onData);
    for (const id of [1, 2, 3]) channel.receive(binaryMessage(id, { id }));
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledOnce());
    expect(onData).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls).toEqual([[JSON.stringify({ ack: 1 })]]);
  });

  it.each([
    ["short header", (): ArrayBuffer => new ArrayBuffer(2)],
    ["malformed JSON", () => chunkMessage(1, 0, 1, new TextEncoder().encode("{"))],
    ["corrupt gzip", () => chunkMessage(1, 0, 1, new Uint8Array([0x1f, 0x8b, 0]))],
    ["zero chunks", () => chunkMessage(1, 0, 0, new Uint8Array())],
    ["invalid chunk index", () => chunkMessage(1, 2, 1, new Uint8Array())],
    ["malformed string JSON", (): string => "{"]
  ] as const)("stops on %s without ACKing a following valid frame", async (_name, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onData = vi.fn();
    const { channel, pc } = setup(onData);
    channel.receive(message());
    channel.receive(binaryMessage(2, { id: 2 }));
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledOnce());
    expect(onData).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it.each(["binary", "string", "close"])("does not pass an incomplete frame on %s", async following => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onData = vi.fn();
    const onComplete = vi.fn();
    const { channel, pc } = setup(onData, true, onComplete);
    channel.receive(chunkMessage(1, 0, 2, new TextEncoder().encode("{")));
    if (following === "close") channel.close();
    else channel.receive(following === "binary" ? binaryMessage(2, { id: 2 }) : JSON.stringify({ id: 2 }));
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledOnce());
    expect(onData).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("cancels queued callbacks and ACKs on explicit cleanup", async () => {
    const first = deferred();
    const onData = vi.fn(async () => { await first.promise; });
    const onComplete = vi.fn();
    const { channel, connection } = setup(onData, true, onComplete);
    channel.receive(binaryMessage(1, { id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await connection.cleanup();
    first.resolve();
    await settle();
    expect(onData).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("allows an onData callback to await cleanup without deadlocking", async () => {
    const completed = vi.fn();
    const { channel, connection } = setup(async () => {
      await connection.cleanup();
      completed();
    });
    channel.receive(binaryMessage(1, { id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(channel.send).not.toHaveBeenCalled();
  });

  it.each(["cleanup", "remote close"])("handles %s during deferred decompression", async action => {
    const gate = deferred();
    const started = delayDecompression(gate, { id: 1 });
    const events: string[] = [];
    const { channel, connection } = setup(data => { events.push(`data:${data.id}`); }, true, () => { events.push("close"); });
    channel.receive(binaryMessage(1, {}, true));
    channel.receive(binaryMessage(2, { id: 2 }));
    await started;
    if (action === "cleanup") await connection.cleanup();
    else channel.close();
    expect(events).toEqual([]);
    gate.resolve();
    if (action === "remote close") {
      await vi.waitFor(() => expect(events).toEqual(["data:1", "data:2", "close"]));
      channel.close();
      expect(events).toEqual(["data:1", "data:2", "close"]);
    } else {
      await settle();
      expect(events).toEqual([]);
    }
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("fails visibly on an unpaced initial message burst instead of growing without bound", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = deferred();
    const onData = vi.fn(async () => { await first.promise; });
    const { channel, pc } = setup(onData);
    for (let id = 1; id <= 1024; id++) channel.receive(binaryMessage(id, { id }));
    expect(pc.close).not.toHaveBeenCalled();
    channel.receive(binaryMessage(1025, { id: 1025 }));
    expect(pc.close).toHaveBeenCalledOnce();
    first.resolve();
    await settle();
    expect(onData).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "Batch data channel buffer limit exceeded" }));
  });

  it("counts partial-frame chunks against the buffer limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { channel, pc } = setup(vi.fn());
    for (let chunk = 0; chunk < 1024; chunk++) {
      channel.receive(chunkMessage(1, chunk, 1025, new Uint8Array()));
    }
    await settle();
    expect(pc.close).not.toHaveBeenCalled();
    channel.receive(chunkMessage(1, 1024, 1025, new Uint8Array()));
    expect(pc.close).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("limits retained bytes even before reaching the message-count limit", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onData = vi.fn();
    const { channel, pc } = setup(onData);
    channel.receive(new ArrayBuffer(64 * 1024 * 1024 + 1));
    expect(pc.close).toHaveBeenCalledOnce();
    expect(onData).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("releases the buffer budget after successful handling", async () => {
    const onData = vi.fn();
    const { channel, pc } = setup(onData);
    for (let id = 1; id <= 1025; id++) {
      channel.receive(binaryMessage(id, { id }));
      // Flush the handler and drain continuations without a timing delay.
      await Promise.resolve();
      await Promise.resolve();
    }
    await settle();
    expect(onData).toHaveBeenCalledTimes(1025);
    expect(channel.send).toHaveBeenCalledTimes(1025);
    expect(pc.close).not.toHaveBeenCalled();
  });

  it("stops instead of ACKing later work if sending an ACK throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onData = vi.fn();
    const { channel, pc } = setup(onData);
    channel.send.mockImplementation(() => { throw new Error("send failed"); });
    channel.receive(binaryMessage(1, { id: 1 }));
    channel.receive(binaryMessage(2, { id: 2 }));
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledOnce());
    expect(onData).toHaveBeenCalledOnce();
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it("reports an onComplete exception without rejecting the background drain", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = deferred();
    const { channel } = setup(async () => { await first.promise; }, true, () => { throw new Error("completion failed"); });
    channel.receive(binaryMessage(1, { id: 1 }));
    channel.close();
    first.resolve();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("[RFWebRTC] Completion callback failed:", expect.any(Error)));
  });

  it.each([undefined, true, false])("selects batch ordering only for explicit realtimeProcessing=%s through useVideoFile", async realtimeProcessing => {
    vi.useFakeTimers();
    const channels: MockDataChannel[] = [];
    vi.stubGlobal("RTCPeerConnection", class extends EventTarget {
      connectionState = "connected";
      iceGatheringState = "complete";
      localDescription?: RTCSessionDescriptionInit;
      addTransceiver() {}
      createDataChannel() { const channel = new MockDataChannel(); channels.push(channel); return channel; }
      async createOffer() { return { sdp: "test offer", type: "offer" }; }
      async setLocalDescription(offer: RTCSessionDescriptionInit) { this.localDescription = offer; }
      async setRemoteDescription() {}
      close() { this.connectionState = "closed"; channels.forEach(channel => channel.close()); }
    });
    const first = deferred();
    const received: number[] = [];
    const connectWrtc = vi.fn(async () => ({ sdp: "test answer", type: "answer" }));
    const connection = await useVideoFile({
      file: new File([], "empty.mp4"),
      connector: { connectWrtc },
      wrtcParams: { realtimeProcessing },
      onData: async data => {
        const id = data.video_metadata!.frame_id;
        received.push(id);
        if (id === 1) await first.promise;
      }
    });
    const channel = channels[0];
    channel.receive(binaryMessage(1, { video_metadata: { frame_id: 1 } }));
    channel.receive(binaryMessage(2, { video_metadata: { frame_id: 2 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(realtimeProcessing === false ? [1] : [1, 2]);
    expect(channel.send).not.toHaveBeenCalled();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.send).toHaveBeenCalledTimes(realtimeProcessing === false ? 2 : 0);
    await connection.cleanup();
  });
});
