import { describe, it, expect } from "vitest";
import { ChunkReassembler, parseBinaryHeader } from "./webrtc";

/**
 * Helper to create a binary message with the protocol header
 */
function createBinaryMessage(
  frameId: number,
  chunkIndex: number,
  totalChunks: number,
  payload: Uint8Array
): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buffer);

  // Write header (little-endian uint32)
  view.setUint32(0, frameId, true);
  view.setUint32(4, chunkIndex, true);
  view.setUint32(8, totalChunks, true);

  // Write payload
  const payloadView = new Uint8Array(buffer, 12);
  payloadView.set(payload);

  return buffer;
}

describe("parseBinaryHeader", () => {
  it("should parse header fields correctly", () => {
    const payload = new TextEncoder().encode('{"test": true}');
    const buffer = createBinaryMessage(42, 0, 1, payload);

    const result = parseBinaryHeader(buffer);

    expect(result.frameId).toBe(42);
    expect(result.chunkIndex).toBe(0);
    expect(result.totalChunks).toBe(1);
    expect(result.payload).toEqual(payload);
  });

  it("should handle large frame IDs", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const buffer = createBinaryMessage(0xffffffff, 100, 200, payload);

    const result = parseBinaryHeader(buffer);

    expect(result.frameId).toBe(0xffffffff);
    expect(result.chunkIndex).toBe(100);
    expect(result.totalChunks).toBe(200);
  });

  it("should extract payload correctly", () => {
    const jsonString = '{"predictions": [{"class": "dog", "confidence": 0.95}]}';
    const payload = new TextEncoder().encode(jsonString);
    const buffer = createBinaryMessage(1, 0, 1, payload);

    const result = parseBinaryHeader(buffer);
    const decoded = new TextDecoder().decode(result.payload);

    expect(decoded).toBe(jsonString);
  });
});

describe("ChunkReassembler", () => {
  it("should return payload immediately for single-chunk messages", () => {
    const reassembler = new ChunkReassembler();
    const payload = new TextEncoder().encode('{"data": "test"}');

    const result = reassembler.processChunk(1, 0, 1, payload);

    expect(result).toEqual(payload);
  });

  it("should reassemble multi-chunk messages in order", () => {
    const reassembler = new ChunkReassembler();

    const chunk0 = new Uint8Array([1, 2, 3]);
    const chunk1 = new Uint8Array([4, 5, 6]);
    const chunk2 = new Uint8Array([7, 8, 9]);

    // Send chunks in order
    expect(reassembler.processChunk(1, 0, 3, chunk0)).toBeNull();
    expect(reassembler.processChunk(1, 1, 3, chunk1)).toBeNull();

    const result = reassembler.processChunk(1, 2, 3, chunk2);

    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it("should reassemble multi-chunk messages out of order", () => {
    const reassembler = new ChunkReassembler();

    const chunk0 = new Uint8Array([1, 2, 3]);
    const chunk1 = new Uint8Array([4, 5, 6]);
    const chunk2 = new Uint8Array([7, 8, 9]);

    // Send chunks out of order
    expect(reassembler.processChunk(1, 2, 3, chunk2)).toBeNull();
    expect(reassembler.processChunk(1, 0, 3, chunk0)).toBeNull();

    const result = reassembler.processChunk(1, 1, 3, chunk1);

    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it("should handle multiple concurrent frames", () => {
    const reassembler = new ChunkReassembler();

    const frame1_chunk0 = new Uint8Array([1, 1]);
    const frame1_chunk1 = new Uint8Array([1, 2]);
    const frame2_chunk0 = new Uint8Array([2, 1]);
    const frame2_chunk1 = new Uint8Array([2, 2]);

    // Interleave chunks from different frames
    expect(reassembler.processChunk(1, 0, 2, frame1_chunk0)).toBeNull();
    expect(reassembler.processChunk(2, 0, 2, frame2_chunk0)).toBeNull();
    expect(reassembler.processChunk(2, 1, 2, frame2_chunk1)).toEqual(
      new Uint8Array([2, 1, 2, 2])
    );
    expect(reassembler.processChunk(1, 1, 2, frame1_chunk1)).toEqual(
      new Uint8Array([1, 1, 1, 2])
    );
  });

  it("should clear pending frames", () => {
    const reassembler = new ChunkReassembler();

    // Start a multi-chunk frame but don't complete it
    reassembler.processChunk(1, 0, 3, new Uint8Array([1, 2, 3]));

    // Clear
    reassembler.clear();

    // Start fresh - should not have old data
    const result = reassembler.processChunk(1, 0, 1, new Uint8Array([9, 9, 9]));
    expect(result).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("should handle JSON payload reassembly", () => {
    const reassembler = new ChunkReassembler();

    const fullJson = '{"predictions": [{"class": "person", "confidence": 0.99}]}';
    const encoder = new TextEncoder();
    const fullPayload = encoder.encode(fullJson);

    // Split into 3 chunks
    const chunkSize = Math.ceil(fullPayload.length / 3);
    const chunk0 = fullPayload.slice(0, chunkSize);
    const chunk1 = fullPayload.slice(chunkSize, chunkSize * 2);
    const chunk2 = fullPayload.slice(chunkSize * 2);

    reassembler.processChunk(1, 0, 3, chunk0);
    reassembler.processChunk(1, 1, 3, chunk1);
    const result = reassembler.processChunk(1, 2, 3, chunk2);

    const decoded = new TextDecoder().decode(result!);
    expect(decoded).toBe(fullJson);
    expect(JSON.parse(decoded)).toEqual({
      predictions: [{ class: "person", confidence: 0.99 }],
    });
  });
});
