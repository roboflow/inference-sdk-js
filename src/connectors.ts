import {
  errorFromResponse,
  REQUEST_TIMEOUT_MS,
  StreamingApi,
  type Connector,
  type RequestOptions,
  type StreamingRequest,
  type StreamingResponse
} from "./api";

/**
 * Talks to the Cloud Streaming API with the API key in the browser.
 *
 * **Demos only**: anyone who opens the page can read the key. Use `withProxyUrl` in production.
 */
function withApiKey(
  apiKey: string,
  options: { workspace?: string; apiUrl?: string } = {}
): Connector {
  if (typeof window !== "undefined") {
    console.warn(
      "[Security Warning] connectors.withApiKey exposes your API key to anyone who opens this page. " +
        "Use connectors.withProxyUrl with createStreamingProxy on your server in production."
    );
  }
  return new StreamingApi({ apiKey, ...options });
}

/**
 * Sends each request as JSON to your backend, which runs it with `createStreamingProxy` and the
 * API key it keeps.
 *
 * @param url - Your proxy endpoint, for example `/api/streaming`.
 * @param options.headers - Extra headers for every request, for example your own auth.
 */
function withProxyUrl(url: string, options: { headers?: Record<string, string> } = {}): Connector {
  return {
    async request<R extends StreamingRequest>(
      request: R,
      { keepalive }: RequestOptions = {}
    ): Promise<StreamingResponse<R>> {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify(request),
        keepalive,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    }
  };
}

export const connectors = { withApiKey, withProxyUrl };
