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

    return {
      connectWrtc: async (offer: WebRTCOffer, wrtcParams: WebRTCParams): Promise<WebRTCWorkerResponse> => {
        const client = InferenceHTTPClient.init({ apiKey, serverUrl });
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
   * @param proxyUrl - Backend proxy endpoint URL
   * @param options - Additional options (reserved for future use)
   * @returns Connector with connectWrtc method
   *
   * @example
   * ```typescript
   * const connector = connectors.withProxyUrl('/api/init-webrtc');
   * const answer = await connector.connectWrtc(offer, wrtcParams);
   * ```
   *
   * @example
   * Backend implementation (Express):
   * ```typescript
   * app.post('/api/init-webrtc', async (req, res) => {
   *   const { offer, wrtcParams } = req.body;
   *   const client = InferenceHTTPClient.init({
   *     apiKey: process.env.ROBOFLOW_API_KEY
   *   });
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
   *   res.json(answer);
   * });
   * ```
   */
  withProxyUrl(proxyUrl: string, options: Record<string, any> = {}): Connector {
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
      }
    };
  }
};
