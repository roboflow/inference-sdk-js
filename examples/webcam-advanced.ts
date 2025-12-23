import { connectors, webrtc, streams } from '@roboflow/inference-sdk';
import type { WebRTCHooks } from '@roboflow/inference-sdk';

// Get DOM elements
const apiKeyInput = document.getElementById("apiKeyInput") as HTMLInputElement;
const serverUrlInput = document.getElementById("serverUrlInput") as HTMLInputElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const getStatsBtn = document.getElementById("getStatsBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const videoEl = document.getElementById("video") as HTMLVideoElement;
const hooksLogEl = document.getElementById("hooksLog")!;

// Checkboxes for options
const contentHintMotionCheckbox = document.getElementById("contentHintMotion") as HTMLInputElement;
const disableDownscalingCheckbox = document.getElementById("disableDownscaling") as HTMLInputElement;
const preferH264Checkbox = document.getElementById("preferH264") as HTMLInputElement;

// Stats elements
const statConnectionState = document.getElementById("statConnectionState")!;
const statIceState = document.getElementById("statIceState")!;
const statBitrate = document.getElementById("statBitrate")!;
const statFramesSent = document.getElementById("statFramesSent")!;
const statCodec = document.getElementById("statCodec")!;
const statResolution = document.getElementById("statResolution")!;

// Track active connection and stats
let activeConnection: Awaited<ReturnType<typeof webrtc.useStream>> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
let lastBytesSent = 0;
let lastTimestamp = 0;

// Simple workflow for object detection
const WORKFLOW_SPEC = {
    "version": "1.0",
    "inputs": [
        { "type": "InferenceImage", "name": "image" }
    ],
    "steps": [
        {
            "type": "roboflow_core/roboflow_object_detection_model@v2",
            "name": "model",
            "images": "$inputs.image",
            "model_id": "rfdetr-medium"
        },
        {
            "type": "roboflow_core/bounding_box_visualization@v1",
            "name": "visualization",
            "image": "$inputs.image",
            "predictions": "$steps.model.predictions"
        }
    ],
    "outputs": [
        {
            "type": "JsonField",
            "name": "annotated",
            "coordinates_system": "own",
            "selector": "$steps.visualization.image"
        }
    ]
};

/**
 * Log a hook event to the UI
 */
function logHookEvent(hookName: string, detail: string) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const event = document.createElement('div');
    event.className = 'hook-event';
    event.innerHTML = `<span class="hook-time">[${time}]</span> <span class="hook-name">${hookName}</span>: <span class="hook-detail">${detail}</span>`;

    // Clear placeholder if first event
    if (hooksLogEl.querySelector('div[style]')) {
        hooksLogEl.innerHTML = '';
    }

    hooksLogEl.appendChild(event);
    hooksLogEl.scrollTop = hooksLogEl.scrollHeight;
}

/**
 * Update status display
 */
function setStatus(text: string) {
    statusEl.textContent = text;
}

/**
 * Reorder codecs to prefer H.264
 * This modifies the SDP to prioritize H.264 codec
 */
function preferH264Codec(sdp: string): string {
    const lines = sdp.split('\r\n');
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Find video m-line and reorder payload types
        if (line.startsWith('m=video')) {
            // Parse the m-line
            const parts = line.split(' ');
            const payloadTypes = parts.slice(3);

            // Find H.264 payload types from rtpmap lines
            const h264Payloads: string[] = [];
            const otherPayloads: string[] = [];

            for (const pt of payloadTypes) {
                // Look ahead for rtpmap line for this payload type
                const rtpmapLine = lines.find(l => l.startsWith(`a=rtpmap:${pt} H264`));
                if (rtpmapLine) {
                    h264Payloads.push(pt);
                } else {
                    otherPayloads.push(pt);
                }
            }

            // Reorder: H.264 first, then others
            const reorderedPayloads = [...h264Payloads, ...otherPayloads];
            result.push([...parts.slice(0, 3), ...reorderedPayloads].join(' '));
        } else {
            result.push(line);
        }
    }

    return result.join('\r\n');
}

/**
 * Create lifecycle hooks for customizing WebRTC behavior
 */
function createHooks(): WebRTCHooks {
    return {
        /**
         * Called after RTCPeerConnection is created.
         * Use this to add event listeners for monitoring connection state.
         */
        onPeerConnectionCreated: (pc) => {
            logHookEvent('onPeerConnectionCreated', `RTCPeerConnection created`);

            // Monitor connection state changes
            pc.addEventListener('connectionstatechange', () => {
                logHookEvent('connectionstatechange', pc.connectionState);
                statConnectionState.textContent = pc.connectionState;

                if (pc.connectionState === 'connected') {
                    setStatus('Connected - Streaming');
                } else if (pc.connectionState === 'failed') {
                    setStatus('Connection failed');
                }
            });

            // Monitor ICE connection state
            pc.addEventListener('iceconnectionstatechange', () => {
                logHookEvent('iceconnectionstatechange', pc.iceConnectionState);
                statIceState.textContent = pc.iceConnectionState;
            });

            // Log ICE candidates
            pc.addEventListener('icecandidate', (event) => {
                if (event.candidate) {
                    const type = event.candidate.type || 'unknown';
                    logHookEvent('icecandidate', `${type} candidate: ${event.candidate.address || 'relay'}`);
                }
            });
        },

        /**
         * Called after a video track is added.
         * Use this to set content hints and configure track settings.
         */
        onTrackAdded: (track, _sender, _pc) => {
            logHookEvent('onTrackAdded', `Track: ${track.kind}, enabled: ${track.enabled}`);

            // Set content hint if checkbox is checked
            if (contentHintMotionCheckbox.checked) {
                // Content hint helps the encoder optimize for the type of content
                // 'motion' is good for video with movement (prioritizes smoothness)
                // 'detail' is better for screen sharing (prioritizes sharpness)
                track.contentHint = 'motion';
                logHookEvent('contentHint', `Set to 'motion' for smoother video encoding`);
            }

            // Log track settings
            const settings = track.getSettings();
            logHookEvent('trackSettings', `${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
        },

        /**
         * Called after SDP offer is created.
         * Use this to inspect or modify the SDP before it's sent.
         */
        onOfferCreated: (offer) => {
            logHookEvent('onOfferCreated', `SDP offer created (${offer.sdp?.length} chars)`);

            // Optionally prefer H.264 codec
            if (preferH264Checkbox.checked && offer.sdp) {
                const modifiedSdp = preferH264Codec(offer.sdp);
                logHookEvent('sdpModified', 'Reordered codecs to prefer H.264');
                return { ...offer, sdp: modifiedSdp };
            }

            return offer;
        }
    };
}

/**
 * Fetch and display WebRTC stats
 */
async function updateStats() {
    if (!activeConnection) return;

    const pc = activeConnection.peerConnection;
    const stats = await pc.getStats();

    stats.forEach((report) => {
        // Outbound video stats
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
            // Calculate bitrate
            const now = report.timestamp;
            const bytes = report.bytesSent;

            if (lastTimestamp > 0) {
                const timeDiff = (now - lastTimestamp) / 1000; // seconds
                const bytesDiff = bytes - lastBytesSent;
                const bitrate = (bytesDiff * 8) / timeDiff / 1000; // kbps
                statBitrate.textContent = `${bitrate.toFixed(0)} kbps`;
            }

            lastBytesSent = bytes;
            lastTimestamp = now;

            // Frames sent
            statFramesSent.textContent = report.framesSent?.toString() || '-';

            // Resolution
            if (report.frameWidth && report.frameHeight) {
                statResolution.textContent = `${report.frameWidth}x${report.frameHeight}`;
            }
        }

        // Codec info
        if (report.type === 'codec' && report.mimeType?.includes('video')) {
            const codec = report.mimeType.replace('video/', '');
            statCodec.textContent = codec;
        }
    });
}

/**
 * Start WebRTC streaming with advanced options
 */
async function start() {
    if (activeConnection) return;

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        alert("Please enter your Roboflow API key!");
        apiKeyInput.focus();
        return;
    }

    startBtn.disabled = true;
    setStatus("Connecting...");

    // Clear previous hook logs
    hooksLogEl.innerHTML = '<div style="opacity: 0.5;">Hook events will appear here when connection starts...</div>';

    // Reset stats
    lastBytesSent = 0;
    lastTimestamp = 0;
    statConnectionState.textContent = 'new';
    statIceState.textContent = '-';
    statBitrate.textContent = '-';
    statFramesSent.textContent = '-';
    statCodec.textContent = '-';
    statResolution.textContent = '-';

    try {
        const serverUrl = serverUrlInput.value.trim();
        const connector = connectors.withApiKey(apiKey, serverUrl ? { serverUrl } : {});

        // Get camera stream
        const cameraStream = await streams.useCamera({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: false
        });

        logHookEvent('cameraReady', `Stream acquired`);

        // Create connection with hooks
        const connection = await webrtc.useStream({
            source: cameraStream,
            connector,
            wrtcParams: {
                workflowSpec: WORKFLOW_SPEC,
                imageInputName: "image",
                streamOutputNames: ["annotated"]
            },
            onData: (data) => {
                // Log occasional data events (not every frame to avoid spam)
                if (data.video_metadata?.frame_id && data.video_metadata.frame_id % 30 === 0) {
                    console.log("[Data] Frame", data.video_metadata.frame_id);
                }
            },
            options: {
                // Disable downscaling to send full resolution
                disableInputStreamDownscaling: disableDownscalingCheckbox.checked
            },
            // Pass our custom hooks
            hooks: createHooks()
        });

        activeConnection = connection;

        // Display processed video
        const remoteStream = await connection.remoteStream();
        videoEl.srcObject = remoteStream;
        await videoEl.play().catch(() => {});

        // Start stats polling
        statsInterval = setInterval(updateStats, 1000);

        // Update UI
        stopBtn.disabled = false;
        getStatsBtn.disabled = false;

    } catch (err) {
        console.error("Connection failed:", err);
        setStatus(`Error: ${(err as Error).message}`);
        startBtn.disabled = false;
    }
}

/**
 * Stop streaming and cleanup
 */
async function stop() {
    if (!activeConnection) return;

    stopBtn.disabled = true;
    setStatus("Stopping...");

    // Stop stats polling
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }

    try {
        await activeConnection.cleanup();
        logHookEvent('cleanup', 'Connection closed');
    } catch (err) {
        console.error("Cleanup error:", err);
    } finally {
        activeConnection = null;
        videoEl.srcObject = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        getStatsBtn.disabled = true;
        setStatus("Idle");
    }
}

/**
 * Manually trigger stats update
 */
function getStats() {
    updateStats();
    logHookEvent('getStats', 'Manual stats refresh');
}

// Event listeners
startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
getStatsBtn.addEventListener("click", getStats);

// Cleanup on page unload
window.addEventListener("pagehide", () => activeConnection?.cleanup());
window.addEventListener("beforeunload", () => activeConnection?.cleanup());
