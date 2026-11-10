import {
    attachStream,
    connectors,
    startStream,
    type CloudStream,
    type Connector,
    type StreamCallbacks
} from "@roboflow/inference-sdk";

const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const apiUrlSelect = document.getElementById("apiUrl") as HTMLSelectElement;
const sourceInput = document.getElementById("source") as HTMLInputElement;
const sourceList = document.getElementById("sources") as HTMLDataListElement;
const workflowInput = document.getElementById("workflow") as HTMLInputElement;
const purposeSelect = document.getElementById("purpose") as HTMLSelectElement;
const jobInput = document.getElementById("job") as HTMLInputElement;
const listSourcesButton = document.getElementById("listSources") as HTMLButtonElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const attachButton = document.getElementById("attach") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const video = document.getElementById("video") as HTMLVideoElement;
const resultsEl = document.getElementById("results") as HTMLElement;

let stream: CloudStream | null = null;

function connector(): Connector {
    const apiKey = apiKeyInput.value.trim();
    return apiKey
        ? connectors.withApiKey(apiKey, { apiUrl: apiUrlSelect.value })
        : connectors.withProxyUrl("/api/streaming");
}

function reset(status: string) {
    stream = null;
    video.srcObject = null;
    startButton.disabled = false;
    attachButton.disabled = false;
    stopButton.disabled = true;
    statusEl.textContent = status;
}

const callbacks: StreamCallbacks = {
    onResult: (result) => {
        statusEl.textContent = `Job ${stream?.jobId}: result ${result.seq}`;
        resultsEl.textContent = JSON.stringify(result.outputs, null, 2);
    },
    onGap: ({ fromSeq, toSeq }) =>
        console.warn(`Results ${fromSeq} to ${toSeq} were not delivered`),
    onEnd: ({ reason }) => reset(`Ended: ${reason}`),
    onError: (error) => reset(`Error: ${error.message}`)
};

async function run(open: () => Promise<CloudStream>) {
    startButton.disabled = true;
    attachButton.disabled = true;
    statusEl.textContent = "Starting…";
    let current: CloudStream;
    try {
        current = await open();
    } catch (error) {
        reset(`Error: ${(error as Error).message}`);
        return;
    }
    stream = current;
    stopButton.disabled = false;
    jobInput.value = current.jobId;
    statusEl.textContent = `Job ${current.jobId}: waiting for it to run…`;
    try {
        video.srcObject = await current.remoteStream();
    } catch (error) {
        // stopping, ending and failing are reported above; this is a refused output
        if (stream === current) statusEl.textContent = `Video: ${(error as Error).message}`;
    }
}

listSourcesButton.addEventListener("click", async () => {
    try {
        const { sources } = await connector().request({ operation: "listSources" });
        sourceList.replaceChildren(
            ...sources.map((source) => new Option(`${source.name} (${source.status})`, source.id))
        );
        statusEl.textContent = `${sources.length} sources`;
    } catch (error) {
        statusEl.textContent = `Error: ${(error as Error).message}`;
    }
});

startButton.addEventListener("click", () =>
    run(() =>
        startStream({
            ...callbacks,
            connector: connector(),
            source: sourceInput.value.trim(),
            workflow: workflowInput.value.trim(),
            purpose: purposeSelect.value === "deployment" ? "deployment" : "preview"
        })
    )
);

attachButton.addEventListener("click", () =>
    run(() => attachStream({ ...callbacks, connector: connector(), jobId: jobInput.value.trim() }))
);

stopButton.addEventListener("click", async () => {
    stopButton.disabled = true;
    const current = stream;
    stream = null;
    try {
        await current?.stop();
        reset("Stopped");
    } catch (error) {
        reset(`Stopped, but the job could not be cancelled: ${(error as Error).message}`);
    }
});
