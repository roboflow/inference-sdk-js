import { connectors, webrtc } from '@roboflow/inference-sdk';
import type { WebRTCOutputData } from '@roboflow/inference-sdk';

// Get DOM elements
const apiKeyInput = document.getElementById("apiKeyInput") as HTMLInputElement;
const serverUrlInput = document.getElementById("serverUrlInput") as HTMLInputElement;
const videoFileInput = document.getElementById("videoFile") as HTMLInputElement;
const fileNameSpan = document.getElementById("fileName")!;
const uploadBtn = document.getElementById("uploadBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const progressContainer = document.getElementById("progressContainer") as HTMLElement;
const progressFill = document.getElementById("progressFill") as HTMLElement;
const progressText = document.getElementById("progressText")!;
const videoContainer = document.getElementById("videoContainer") as HTMLElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const resultsContainer = document.getElementById("resultsContainer") as HTMLElement;
const resultsList = document.getElementById("resultsList")!;

// Track active connection
let activeConnection: Awaited<ReturnType<typeof webrtc.useVideoFile>> | null = null;
let selectedFile: File | null = null;

// Workflow specification for object detection
const WORKFLOW_SPEC = {
    "version": "1.0",
    "inputs": [
        {
            "type": "InferenceImage",
            "name": "image"
        }
    ],
    "steps": [
        {
            "type": "roboflow_core/roboflow_object_detection_model@v2",
            "name": "model",
            "images": "$inputs.image",
            "model_id": "rfdetr-medium"
        },
        {
            "type": "roboflow_core/property_definition@v1",
            "name": "count",
            "data": "$steps.model.predictions",
            "operations": [
                {
                    "type": "SequenceLength"
                }
            ]
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
            "name": "predictions",
            "selector": "$steps.model.predictions"
        },
        {
            "type": "JsonField",
            "name": "count",
            "selector": "$steps.count.output"
        },
        {
            "type": "JsonField",
            "name": "output_image",
            "selector": "$steps.visualization.image"
        }
    ]
};

/**
 * Update status display
 */
function setStatus(text: string) {
    statusEl.textContent = text;
    console.log("[Status]", text);
}

/**
 * Update progress bar
 */
function setProgress(percent: number, label?: string) {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = label || `${percent.toFixed(1)}%`;
}

/**
 * Format seconds as MM:SS.ms
 */
function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

/**
 * Add a result to the results list
 */
function addResult(data: WebRTCOutputData) {
    const item = document.createElement("div");
    item.className = "result-item";

    const frameId = data.video_metadata?.frame_id ?? "?";
    const count = (data.serialized_output_data?.count as number) ?? 0;

    // Calculate video time from pts * time_base
    const pts = data.video_metadata?.pts;
    const timeBase = data.video_metadata?.time_base;
    const videoTime = (pts != null && timeBase != null) ? formatTime(pts * timeBase) : "--:--";

    item.textContent = `#${frameId} [${videoTime}] ${count} object(s)`;

    // Add newest at the top
    resultsList.prepend(item);
}

/**
 * Clear results
 */
function clearResults() {
    resultsList.innerHTML = "";
}

/**
 * Handle file selection
 */
videoFileInput.addEventListener("change", (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
        selectedFile = file;
        fileNameSpan.textContent = file.name;
        uploadBtn.disabled = false;
        setStatus(`Ready to upload: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
        selectedFile = null;
        fileNameSpan.textContent = "No file selected";
        uploadBtn.disabled = true;
        setStatus("Select a video file");
    }
});

/**
 * Start upload and processing
 */
async function startUpload() {
    if (!selectedFile) {
        alert("Please select a video file first");
        return;
    }

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        alert("Please enter your Roboflow API key");
        apiKeyInput.focus();
        return;
    }

    // Reset UI
    uploadBtn.disabled = true;
    stopBtn.disabled = false;
    progressContainer.style.display = "block";
    resultsContainer.style.display = "block";
    clearResults();
    setProgress(0, "Starting...");
    setStatus("Connecting...");

    try {
        const serverUrl = serverUrlInput.value.trim();
        const connectorOptions = serverUrl ? { serverUrl } : {};
        const connector = connectors.withApiKey(apiKey, connectorOptions);

        let framesReceived = 0;

        activeConnection = await webrtc.useVideoFile({
            file: selectedFile,
            connector,
            wrtcParams: {
                workflowSpec: WORKFLOW_SPEC,
                imageInputName: "image",
                streamOutputNames: ["output_image"],
                dataOutputNames: ["predictions", "count"],
                requestedPlan: "webrtc-gpu-medium",
                realtimeProcessing: true  // Required for video stream output
            },
            onData: (data) => {
                framesReceived++;
                console.log("[Data]", data);
                addResult(data);

                // Check for processing_complete in various locations
                const isComplete = data.processing_complete ||
                    data.video_metadata?.processing_complete ||
                    data.serialized_output_data?.processing_complete;

                if (isComplete) {
                    setStatus(`Complete! Processed ${framesReceived} frames`);
                    setProgress(100, "Complete!");
                    cleanup();
                } else {
                    setStatus(`Processing... (${framesReceived} frames received)`);
                }
            },
            onUploadProgress: (bytesUploaded, totalBytes) => {
                const percent = (bytesUploaded / totalBytes) * 100;
                setProgress(percent, `Uploading: ${percent.toFixed(1)}%`);

                if (bytesUploaded === totalBytes) {
                    setStatus("Upload complete, processing video...");
                    setProgress(100, "Processing...");
                }
            },
            onComplete: () => {
                console.log("[Complete] Processing finished, channel closed");
                setStatus(`Complete! Processed ${framesReceived} frames`);
                setProgress(100, "Complete!");
                cleanup();
            },
        });

        setStatus("Connected, uploading...");

        // Show video container and attach remote stream
        videoContainer.style.display = "block";
        const remoteStream = await activeConnection.remoteStream();
        remoteVideo.srcObject = remoteStream;

    } catch (err) {
        console.error("[Error]", err);
        setStatus(`Error: ${(err as Error).message}`);
        cleanup();
    }
}

/**
 * Stop processing
 */
async function stopProcessing() {
    setStatus("Stopping...");
    await cleanup();
    setStatus("Stopped");
}

/**
 * Cleanup connection and reset UI
 */
async function cleanup() {
    if (activeConnection) {
        try {
            await activeConnection.cleanup();
        } catch (err) {
            console.error("[Cleanup error]", err);
        }
        activeConnection = null;
    }

    // Clear video
    remoteVideo.srcObject = null;

    uploadBtn.disabled = !selectedFile;
    stopBtn.disabled = true;
}

// Attach event listeners
uploadBtn.addEventListener("click", startUpload);
stopBtn.addEventListener("click", stopProcessing);

// Cleanup on page unload
window.addEventListener("pagehide", cleanup);
window.addEventListener("beforeunload", cleanup);
