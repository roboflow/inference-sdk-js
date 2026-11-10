import {
    connectors,
    startStream,
    streams,
    type CloudStream,
    type Connector
} from "@roboflow/inference-sdk";

const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const apiUrlSelect = document.getElementById("apiUrl") as HTMLSelectElement;
const workflowInput = document.getElementById("workflow") as HTMLInputElement;
const imageOutputInput = document.getElementById("imageOutput") as HTMLInputElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const video = document.getElementById("video") as HTMLVideoElement;
const resultsEl = document.getElementById("results") as HTMLElement;

// Detects objects with RF-DETR and draws their boxes into the "annotated" image output.
const DETECT_OBJECTS = {
    version: "1.0",
    inputs: [{ type: "InferenceImage", name: "image" }],
    steps: [
        {
            type: "roboflow_core/roboflow_object_detection_model@v2",
            name: "model",
            images: "$inputs.image",
            model_id: "rfdetr-medium"
        },
        {
            type: "roboflow_core/bounding_box_visualization@v1",
            name: "boxes",
            image: "$inputs.image",
            predictions: "$steps.model.predictions"
        }
    ],
    outputs: [
        { type: "JsonField", name: "predictions", selector: "$steps.model.predictions" },
        { type: "JsonField", name: "annotated", selector: "$steps.boxes.image" }
    ]
};

let stream: CloudStream | null = null;
let camera: MediaStream | null = null;

function connector(): Connector {
    const apiKey = apiKeyInput.value.trim();
    return apiKey
        ? connectors.withApiKey(apiKey, { apiUrl: apiUrlSelect.value })
        : connectors.withProxyUrl("/api/streaming");
}

function reset(status: string) {
    stream = null;
    streams.stopStream(camera);
    camera = null;
    video.srcObject = null;
    startButton.disabled = false;
    stopButton.disabled = true;
    statusEl.textContent = status;
}

async function start() {
    startButton.disabled = true;
    statusEl.textContent = "Opening the camera…";
    const workflow = workflowInput.value.trim();
    try {
        camera = await streams.useCamera({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        statusEl.textContent = "Starting the Workflow…";
        stream = await startStream({
            connector: connector(),
            source: camera,
            workflow: workflow || DETECT_OBJECTS,
            imageOutput: imageOutputInput.value.trim() || (workflow ? undefined : "annotated"),
            onResult: (result) => {
                statusEl.textContent = `Result ${result.seq}, ${result.latencyMs} ms behind`;
                resultsEl.textContent = JSON.stringify(result.outputs, null, 2);
            },
            onGap: ({ fromSeq, toSeq }) =>
                console.warn(`Results ${fromSeq} to ${toSeq} were not delivered`),
            onEnd: ({ reason }) => reset(`Ended: ${reason}`),
            onError: (error) => reset(`Error: ${error.message}`)
        });
    } catch (error) {
        reset(`Error: ${(error as Error).message}`);
        return;
    }
    stopButton.disabled = false;
    statusEl.textContent = "Waiting for the job to start…";
    const current = stream;
    try {
        video.srcObject = await current.remoteStream();
    } catch (error) {
        // stopping, ending and failing are reported above; this is a refused output
        if (stream === current) statusEl.textContent = `Video: ${(error as Error).message}`;
    }
}

async function stop() {
    stopButton.disabled = true;
    const current = stream;
    stream = null;
    try {
        await current?.stop();
        reset("Stopped");
    } catch (error) {
        reset(`Stopped, but the job could not be cancelled: ${(error as Error).message}`);
    }
}

startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
