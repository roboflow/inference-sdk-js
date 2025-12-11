/**
 * Base URL for the Roboflow API (used for TURN server configuration)
 * Can be overridden via environment variable in Node.js environments
 */
const RF_API_BASE_URL = typeof process !== "undefined" && process.env?.RF_API_BASE_URL
  ? process.env.RF_API_BASE_URL
  : "https://api.roboflow.com";

/**
 * List of known Roboflow serverless API URLs where auto TURN config applies
 */
const ROBOFLOW_SERVERLESS_URLS = [
  "https://serverless.roboflow.com"
];

export interface WebRTCWorkerConfig {
  imageInputName?: string;
  streamOutputNames?: string[];
  dataOutputNames?: string[];
  threadPoolWorkers?: number;
  /**
   * Workflow parameters to pass to the workflow execution
   */
  workflowsParameters?: Record<string, any>;
  /**
   * ICE servers for WebRTC connections (used for both client and server)
   */
  iceServers?: RTCIceServerConfig[];
  /**
   * Processing timeout in seconds (serverless only)
   * @default 600
   */
  processingTimeout?: number;
  /**
   * Requested compute plan (serverless only)
   * @example "webrtc-gpu-small"
   */
  requestedPlan?: string;
  /**
   * Requested region for processing (serverless only)
   * @example "us"
   */
  requestedRegion?: string;
}

/**
 * ICE server configuration for WebRTC connections
 *
 * Use this to configure custom STUN/TURN servers for users behind
 * symmetric NAT or restrictive firewalls.
 */
export interface RTCIceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface WebRTCOffer {
  sdp: string;
  type: string;
}

export type WorkflowSpec = Record<string, any>;

export interface WebRTCWorkerResponse {
  status?: string;
  sdp: string;
  type: string;
  context?: {
    request_id: string | null;
    pipeline_id: string | null;
  };
}

export interface WebRTCParams {
  workflowSpec?: WorkflowSpec;
  workspaceName?: string;
  workflowId?: string;
  imageInputName?: string;
  streamOutputNames?: string[];
  dataOutputNames?: string[];
  threadPoolWorkers?: number;
  /**
   * Workflow parameters to pass to the workflow execution
   */
  workflowsParameters?: Record<string, any>;
  /**
   * ICE servers for WebRTC connections (used for both client and server)
   *
   * Use this to specify custom STUN/TURN servers for users behind
   * symmetric NAT or restrictive firewalls. The same configuration is
   * used for both the client-side RTCPeerConnection and sent to the
   * server via webrtc_config.
   *
   * @example
   * ```typescript
   * iceServers: [
   *   { urls: ["stun:stun.l.google.com:19302"] },
   *   { urls: ["turn:turn.example.com:3478"], username: "user", credential: "pass" }
   * ]
   * ```
   */
  iceServers?: RTCIceServerConfig[];
  /**
   * Processing timeout in seconds (serverless only)
   * @default 600
   */
  processingTimeout?: number;
  /**
   * Requested compute plan (serverless only)
   * @example "webrtc-gpu-small"
   */
  requestedPlan?: string;
  /**
   * Requested region for processing (serverless only)
   * @example "us"
   */
  requestedRegion?: string;
}

export interface Connector {
  connectWrtc(offer: WebRTCOffer, wrtcParams: WebRTCParams): Promise<WebRTCWorkerResponse>;
  /**
   * Fetch ICE servers (TURN configuration) for WebRTC connections
   * This should be called BEFORE creating the RTCPeerConnection to ensure
   * proper NAT traversal configuration.
   *
   * @returns Promise resolving to ICE server configuration, or null/undefined if not available
   */
  getIceServers?(): Promise<RTCIceServerConfig[] | null>;
  _apiKey?: string;
  _serverUrl?: string;
}

export class InferenceHTTPClient {
  private apiKey: string;
  private serverUrl: string;

  /**
   * @private
   * Use InferenceHTTPClient.init() instead
   */
  private constructor(apiKey: string, serverUrl: string = "https://serverless.roboflow.com") {
    this.apiKey = apiKey;
    this.serverUrl = serverUrl;
  }

  static init({ apiKey, serverUrl }: { apiKey: string; serverUrl?: string }): InferenceHTTPClient {
    if (!apiKey) {
      throw new Error("apiKey is required");
    }
    return new InferenceHTTPClient(apiKey, serverUrl);
  }

  /**
   * Initialize a WebRTC worker pipeline
   *
   * @param params - Pipeline parameters
   * @param params.offer - WebRTC offer { sdp, type }
   * @param params.workflowSpec - Workflow specification
   * @param params.config - Additional configuration
   * @param params.config.imageInputName - Input image name (default: "image")
   * @param params.config.streamOutputNames - Output stream names for video (default: [])
   * @param params.config.dataOutputNames - Output data names (default: ["string"])
   * @param params.config.threadPoolWorkers - Thread pool workers (default: 4)
   * @returns Promise resolving to answer with SDP and pipeline ID
   *
   * @example
   * ```typescript
   * const answer = await client.initializeWebrtcWorker({
   *   offer: { sdp, type },
   *   workflowSpec: { ... },
   *   config: {
   *     imageInputName: "image",
   *     streamOutputNames: ["output_image"]
   *   }
   * });
   * ```
   */
  async initializeWebrtcWorker({
    offer,
    workflowSpec,
    workspaceName,
    workflowId,
    config = {}
  }: {
    offer: WebRTCOffer;
    workflowSpec?: WorkflowSpec;
    workspaceName?: string;
    workflowId?: string;
    config?: WebRTCWorkerConfig;
  }): Promise<WebRTCWorkerResponse> {
    if (!offer || !offer.sdp || !offer.type) {
      throw new Error("offer with sdp and type is required");
    }

    // Validate that either workflowSpec OR (workspaceName + workflowId) is provided
    const hasWorkflowSpec = !!workflowSpec;
    const hasWorkspaceIdentifier = !!(workspaceName && workflowId);

    if (!hasWorkflowSpec && !hasWorkspaceIdentifier) {
      throw new Error("Either workflowSpec OR (workspaceName + workflowId) is required");
    }
    if (hasWorkflowSpec && hasWorkspaceIdentifier) {
      throw new Error("Provide either workflowSpec OR (workspaceName + workflowId), not both");
    }

    const {
      imageInputName = "image",
      streamOutputNames = [],
      dataOutputNames = ["string"],
      threadPoolWorkers = 4,
      workflowsParameters = {},
      iceServers,
      processingTimeout,
      requestedPlan,
      requestedRegion
    } = config;

    // Build workflow_configuration based on what's provided
    const workflowConfiguration: any = {
      type: "WorkflowConfiguration",
      image_input_name: imageInputName,
      workflows_parameters: workflowsParameters,
      workflows_thread_pool_workers: threadPoolWorkers,
      cancel_thread_pool_tasks_on_exit: true,
      video_metadata_input_name: "video_metadata"
    };

    if (hasWorkflowSpec) {
      workflowConfiguration.workflow_specification = workflowSpec;
    } else {
      workflowConfiguration.workspace_name = workspaceName;
      workflowConfiguration.workflow_id = workflowId;
    }

    const payload: Record<string, any> = {
      workflow_configuration: workflowConfiguration,
      api_key: this.apiKey,
      webrtc_realtime_processing: true,
      webrtc_offer: {
        sdp: offer.sdp,
        type: offer.type
      },
      webrtc_config: iceServers ? { iceServers } : null,
      stream_output: streamOutputNames,
      data_output: dataOutputNames
    };

    // Add serverless-specific fields if provided
    if (processingTimeout !== undefined) {
      payload.processing_timeout = processingTimeout;
    }
    if (requestedPlan !== undefined) {
      payload.requested_plan = requestedPlan;
    }
    if (requestedRegion !== undefined) {
      payload.requested_region = requestedRegion;
    }
    console.trace("payload", payload);
    const response = await fetch(`${this.serverUrl}/initialise_webrtc_worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`initialise_webrtc_worker failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    return result;
  }

  async terminatePipeline({ pipelineId }: { pipelineId: string }): Promise<void> {
    if (!pipelineId) {
      throw new Error("pipelineId is required");
    }

    await fetch(
      `${this.serverUrl}/inference_pipelines/${pipelineId}/terminate?api_key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  /**
   * Fetch TURN server configuration from Roboflow API
   *
   * This automatically fetches TURN server credentials for improved WebRTC
   * connectivity through firewalls and NAT. Only applicable when using
   * Roboflow serverless infrastructure.
   *
   * @returns Promise resolving to ICE server configuration, or null if not applicable
   *
   * @example
   * ```typescript
   * const client = InferenceHTTPClient.init({ apiKey: "your-api-key" });
   * const iceServers = await client.fetchTurnConfig();
   * // Returns: [{ urls: ["turn:..."], username: "...", credential: "..." }]
   * ```
   */
  async fetchTurnConfig(): Promise<RTCIceServerConfig[] | null> {
    // Only fetch TURN config for Roboflow serverless URLs
    if (!ROBOFLOW_SERVERLESS_URLS.includes(this.serverUrl)) {
      return null;
    }

    try {
      const response = await fetch(
        `${RF_API_BASE_URL}/webrtc_turn_config?api_key=${this.apiKey}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        }
      );

      if (!response.ok) {
        console.warn(`[RFWebRTC] Failed to fetch TURN config (${response.status}), using defaults`);
        return null;
      }

      const turnConfig = await response.json();

      // Handle 3 formats:
      // 1. Single server object: { urls, username, credential }
      // 2. Array of servers: [{ urls, username, credential }, ...]
      // 3. Object with iceServers: { iceServers: [...] }
      let iceServersRaw: any[];

      if (Array.isArray(turnConfig)) {
        // Format 2: array of servers
        iceServersRaw = turnConfig;
      } else if (turnConfig.iceServers && Array.isArray(turnConfig.iceServers)) {
        // Format 3: object with iceServers array
        iceServersRaw = turnConfig.iceServers;
      } else if (turnConfig.urls) {
        // Format 1: single server object - wrap in array
        iceServersRaw = [turnConfig];
      } else {
        console.warn("[RFWebRTC] Invalid TURN config format, using defaults");
        return null;
      }

      // Normalize the ICE servers format
      const iceServers: RTCIceServerConfig[] = iceServersRaw.map((server: any) => ({
        urls: Array.isArray(server.urls) ? server.urls : [server.urls],
        username: server.username,
        credential: server.credential
      }));

      return iceServers;
    } catch (err) {
      console.warn("[RFWebRTC] Error fetching TURN config:", err);
      return null;
    }
  }
}

/**
 * Connectors for establishing WebRTC connections to Roboflow
 */
export const connectors = {
  /**
   * Create a connector that uses API key directly
   *
   * **WARNING**: If you use this in the frontend, it will expose your API key. 
   * Use only for demos/testing.
   * For production, use withProxyUrl() with a backend proxy.
   *
   * @param apiKey - Roboflow API key
   * @param options - Additional options
   * @param options.serverUrl - Custom Roboflow server URL
   * @returns Connector with connectWrtc method
   *
   * @example
   * ```typescript
   * const connector = connectors.withApiKey("your-api-key");
   * const answer = await connector.connectWrtc(offer, wrtcParams);
   * ```
   */
  withApiKey(apiKey: string, options: { serverUrl?: string } = {}): Connector {
    const { serverUrl } = options;

    // Warn if running in browser context
    if (typeof window !== 'undefined') {
      console.warn(
        '[Security Warning] Using API key directly in browser will expose it. ' +
        'Use connectors.withProxyUrl() for production. ' +
        'See: https://docs.roboflow.com/api-reference/authentication#securing-your-api-key'
      );
    }

    const client = InferenceHTTPClient.init({ apiKey, serverUrl });

    return {
      connectWrtc: async (offer: WebRTCOffer, wrtcParams: WebRTCParams): Promise<WebRTCWorkerResponse> => {
        console.log("wrtcParams", wrtcParams);
        const answer = await client.initializeWebrtcWorker({
          offer,
          workflowSpec: wrtcParams.workflowSpec,
          workspaceName: wrtcParams.workspaceName,
          workflowId: wrtcParams.workflowId,
          config: {
            imageInputName: wrtcParams.imageInputName,
            streamOutputNames: wrtcParams.streamOutputNames,
            dataOutputNames: wrtcParams.dataOutputNames,
            threadPoolWorkers: wrtcParams.threadPoolWorkers,
            workflowsParameters: wrtcParams.workflowsParameters,
            iceServers: wrtcParams.iceServers,
            processingTimeout: wrtcParams.processingTimeout,
            requestedPlan: wrtcParams.requestedPlan,
            requestedRegion: wrtcParams.requestedRegion
          }
        });

        return answer;
      },

      /**
       * Fetch TURN server configuration for improved WebRTC connectivity
       */
      getIceServers: async (): Promise<RTCIceServerConfig[] | null> => {
        return await client.fetchTurnConfig();
      },

      // Store apiKey for cleanup
      _apiKey: apiKey,
      _serverUrl: serverUrl
    };
  },

  /**
   * Create a connector that uses a backend proxy (recommended for production)
   *
   * Your backend receives the offer and wrtcParams, adds the secret API key,
   * and forwards to Roboflow. This keeps your API key secure.
   *
   * For improved WebRTC connectivity through firewalls, implement a separate
   * endpoint for TURN server configuration that calls `fetchTurnConfig()`.
   *
   * @param proxyUrl - Backend proxy endpoint URL for WebRTC initialization
   * @param options - Additional options
   * @param options.turnConfigUrl - Optional URL for fetching TURN server configuration
   * @returns Connector with connectWrtc and optional getIceServers methods
   *
   * @example
   * ```typescript
   * // Frontend: Create connector with TURN config endpoint
   * const connector = connectors.withProxyUrl('/api/init-webrtc', {
   *   turnConfigUrl: '/api/turn-config'
   * });
   * ```
   *
   * @example
   * Backend implementation (Express) with TURN server support:
   * ```typescript
   * // Endpoint for TURN configuration (called first by SDK)
   * app.get('/api/turn-config', async (req, res) => {
   *   const client = InferenceHTTPClient.init({
   *     apiKey: process.env.ROBOFLOW_API_KEY
   *   });
   *   const iceServers = await client.fetchTurnConfig();
   *   res.json({ iceServers });
   * });
   *
   * // Endpoint for WebRTC initialization
   * app.post('/api/init-webrtc', async (req, res) => {
   *   const { offer, wrtcParams } = req.body;
   *   const client = InferenceHTTPClient.init({
   *     apiKey: process.env.ROBOFLOW_API_KEY
   *   });
   *
   *   const answer = await client.initializeWebrtcWorker({
   *     offer,
   *     workflowSpec: wrtcParams.workflowSpec,
   *     workspaceName: wrtcParams.workspaceName,
   *     workflowId: wrtcParams.workflowId,
   *     config: {
   *       imageInputName: wrtcParams.imageInputName,
   *       streamOutputNames: wrtcParams.streamOutputNames,
   *       dataOutputNames: wrtcParams.dataOutputNames,
   *       threadPoolWorkers: wrtcParams.threadPoolWorkers,
   *       workflowsParameters: wrtcParams.workflowsParameters,
   *       iceServers: wrtcParams.iceServers,
   *       processingTimeout: wrtcParams.processingTimeout,
   *       requestedPlan: wrtcParams.requestedPlan,
   *       requestedRegion: wrtcParams.requestedRegion
   *     }
   *   });
   *
   *   res.json(answer);
   * });
   * ```
   */
  withProxyUrl(proxyUrl: string, options: { turnConfigUrl?: string } = {}): Connector {
    const { turnConfigUrl } = options;

    return {
      connectWrtc: async (offer: WebRTCOffer, wrtcParams: WebRTCParams): Promise<WebRTCWorkerResponse> => {
        const response = await fetch(proxyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offer,
            wrtcParams
          })
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`Proxy request failed (${response.status}): ${errorText}`);
        }

        return await response.json();
      },

      /**
       * Fetch TURN server configuration from the proxy backend
       * Only available if turnConfigUrl was provided
       */
      getIceServers: turnConfigUrl
        ? async (): Promise<RTCIceServerConfig[] | null> => {
            try {
              const response = await fetch(turnConfigUrl, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
              });

              if (!response.ok) {
                console.warn(`[RFWebRTC] Failed to fetch TURN config from proxy (${response.status})`);
                return null;
              }

              const data = await response.json();
              return data.iceServers || null;
            } catch (err) {
              console.warn("[RFWebRTC] Error fetching TURN config from proxy:", err);
              return null;
            }
          }
        : undefined
    };
  }
};
