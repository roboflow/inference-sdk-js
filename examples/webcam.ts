import { connectors, webrtc, streams } from '@roboflow/inference-sdk';

// Get DOM elements
const apiKeyInput = document.getElementById("apiKeyInput") as HTMLInputElement;
const serverUrlInput = document.getElementById("serverUrlInput") as HTMLInputElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const reconfigureBtn = document.getElementById("reconfigureBtn") as HTMLButtonElement;
const jsonInput = document.getElementById("jsonInput") as HTMLTextAreaElement;
const statusEl = document.getElementById("status")!;
const videoEl = document.getElementById("video") as HTMLVideoElement;

// Track active connection
let activeConnection: Awaited<ReturnType<typeof webrtc.useStream>> | null = null;

// Workflow specification for segmentation demo
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
            "type": "roboflow_core/blur_visualization@v1",
            "name": "blur_visualization",
            "image": "$inputs.image",
            "predictions": "$steps.model.predictions"
        },
        {
            "type": "roboflow_core/property_definition@v1",
            "name": "property_definition",
            "data": "$steps.model.predictions",
            "operations": [
                {
                    "type": "SequenceLength"
                }
            ]
        },
        {
            "type": "roboflow_core/bounding_box_visualization@v1",
            "name": "bounding_box_visualization",
            "image": "$inputs.image",
            "predictions": "$steps.model.predictions"
        }
    ],
    "outputs": [
        {
            "type": "JsonField",
            "name": "blur",
            "coordinates_system": "own",
            "selector": "$steps.blur_visualization.image"
        },
        {
            "type": "JsonField",
            "name": "countis",
            "coordinates_system": "own",
            "selector": "$steps.property_definition.output"
        },
        {
            "type": "JsonField",
            "name": "bb",
            "coordinates_system": "own",
            "selector": "$steps.bounding_box_visualization.image"
        }
    ]
};

/**
 * Update status display
 */
function setStatus(text: string) {
    statusEl.textContent = text;
    console.log("[UI Status]", text);
}

/**
 * Connect to Roboflow WebRTC streaming
 */
async function connectWebcamToRoboflowWebrtc(options: {
    apiKey?: string;
    serverUrl?: string;
    workflowSpec?: typeof WORKFLOW_SPEC;
    onData?: (data: unknown) => void;
} = {}) {
    const {
        apiKey = apiKeyInput.value.trim(),
        serverUrl = serverUrlInput.value.trim(),
        workflowSpec = WORKFLOW_SPEC,
        onData
    } = options;

    // Validate API key
    if (!apiKey) {
        throw new Error("API key is required");
    }

    // Create connector with API key
    const connectorOptions = serverUrl ? { serverUrl } : {};
    const connector = connectors.withApiKey(apiKey, connectorOptions);

    // Establish WebRTC connection
    const connection = await webrtc.useStream({
        source: await streams.useCamera({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30, max: 30 }
            },
            audio: false
        }),
        connector: connector,
        wrtcParams: {
            workflowSpec: workflowSpec,
            // workspaceName: "meh-dq9yn",
            // workflowId: "custom-workflow-2",
            imageInputName: "image",
            streamOutputNames: ["bb"],
            dataOutputNames: ["countis"]
        },
        onData: onData,
        options: {
            disableInputStreamDownscaling: true
        }
    });

    return connection;
}

/**
 * Start WebRTC streaming with Roboflow
 */
async function start() {
    if (activeConnection) {
        console.warn("Already connected");
        return;
    }

    // Disable start button while connecting
    startBtn.disabled = true;
    setStatus("Connecting...");

    try {
        // Connect to Roboflow (reads from input fields by default)
        const connection = await connectWebcamToRoboflowWebrtc({
            onData: (data) => {
                console.log("[Data]", data);
            }
        });

        activeConnection = connection;

        // Get and display the processed video stream
        const remoteStream = await connection.remoteStream();
        videoEl.srcObject = remoteStream;
        videoEl.controls = false;

        // Ensure video plays
        try {
            await videoEl.play();
            console.log("[UI] Video playing");
        } catch (err) {
            console.warn("[UI] Autoplay failed:", err);
        }

        // Update UI
        setStatus("Connected - Processing video");
        stopBtn.disabled = false;
        reconfigureBtn.disabled = false;

        console.log("[UI] Successfully connected!");

    } catch (err) {
        console.error("[UI] Connection failed:", err);

        // Handle validation errors
        if ((err as Error).message === "API key is required") {
            alert("Please enter your Roboflow API key!");
            apiKeyInput.focus();
        }

        setStatus(`Error: ${(err as Error).message}`);
        startBtn.disabled = false;
        activeConnection = null;
    }
}

/**
 * Stop video processing and cleanup
 */
async function stop() {
    if (!activeConnection) {
        return;
    }

    stopBtn.disabled = true;
    setStatus("Stopping...");

    try {
        await activeConnection.cleanup();
        console.log("[UI] Cleanup complete");
    } catch (err) {
        console.error("[UI] Cleanup error:", err);
    } finally {
        // Reset UI
        activeConnection = null;
        videoEl.srcObject = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        reconfigureBtn.disabled = true;
        setStatus("Idle");
    }
}

/**
 * Reconfigure outputs from the textarea
 */
function handleReconfigure() {
    if (!activeConnection) {
        console.warn("[UI] No active connection");
        return;
    }

    try {
        const json = JSON.parse(jsonInput.value);
        console.log("[UI] Reconfiguring outputs:", json);
        activeConnection.reconfigureOutputs(json);
        setStatus("Outputs reconfigured - check console");
    } catch (err) {
        console.error("[UI] Invalid JSON:", err);
        alert("Invalid JSON: " + (err as Error).message);
    }
}

// Attach event listeners
startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
reconfigureBtn.addEventListener("click", handleReconfigure);

// Cleanup on page unload
window.addEventListener("pagehide", () => {
    if (activeConnection) {
        activeConnection.cleanup();
    }
});

window.addEventListener("beforeunload", () => {
    if (activeConnection) {
        activeConnection.cleanup();
    }
});
