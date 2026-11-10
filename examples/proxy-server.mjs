// The production pattern: the browser uses connectors.withProxyUrl("/api/streaming") and this
// server runs each request with the API key it keeps. No dependencies besides the SDK.
//
//   npm run build
//   ROBOFLOW_API_KEY=... node examples/proxy-server.mjs
//
// `npm run dev` forwards /api to this server, so the examples use it when their API key field is
// empty. ROBOFLOW_API_URL=https://api.roboflow.one points it at staging.
import { createServer } from "node:http";
import { createStreamingProxy } from "@roboflow/inference-sdk";

const PORT = Number(process.env.PORT ?? 8787);
const apiKey = process.env.ROBOFLOW_API_KEY;
if (!apiKey) {
    console.error("Set ROBOFLOW_API_KEY.");
    process.exit(1);
}

const handle = createStreamingProxy({
    apiKey,
    apiUrl: process.env.ROBOFLOW_API_URL,
    // Decide what your users may do: check who is asking in the request handler below (this demo
    // trusts everyone) and the operation here. This demo lets browsers run previews but not
    // deployments, which keep running, and billing, after the page closes.
    authorize: (request) => request.operation !== "startJob" || request.job.purpose !== "deployment"
});

async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return undefined;
    }
}

createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/streaming") {
        response.writeHead(404).end();
        return;
    }
    const { status, body } = await handle(await readJson(request));
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}).listen(PORT, () => {
    console.log(`Cloud Streaming proxy on http://localhost:${PORT}/api/streaming`);
});
