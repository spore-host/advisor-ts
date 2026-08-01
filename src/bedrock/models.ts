// Which models this account can actually use.
//
// Bedrock model access is per-account and per-region, and a model the account has
// not been granted returns AccessDeniedException on first use. Discovering that at
// the first question — after the user has typed one — is a bad first experience,
// so a caller can list what is available and choose, or fail early with a clear
// message.
//
// Note this uses the CONTROL plane (`bedrock`), not the runtime (`bedrock-runtime`).
// Listing models is free; only inference is billable.

import {
  BedrockClient,
  ListFoundationModelsCommand,
  type FoundationModelSummary,
} from "@aws-sdk/client-bedrock";

/** A model the account may be able to call. */
export interface AvailableModel {
  modelId: string;
  modelName?: string;
  provider?: string;
  /** True when the model supports the tool-use this advisor depends on. */
  supportsToolUse: boolean;
  /** True when it supports streaming responses. */
  supportsStreaming: boolean;
}

/**
 * List text models in the region that support the on-demand inference this
 * library uses.
 *
 * IMPORTANT: this reports what EXISTS, not what the account has been GRANTED —
 * the control plane lists models regardless of access-grant state. So a model
 * appearing here can still fail with AccessDeniedException, and callers must
 * present this as a candidate list rather than a guarantee. Saying "you have
 * access to these" from this data would be a claim the API never made.
 */
export async function listModels(client: BedrockClient): Promise<AvailableModel[]> {
  const out = await client.send(
    new ListFoundationModelsCommand({ byOutputModality: "TEXT", byInferenceType: "ON_DEMAND" }),
  );
  return (out.modelSummaries ?? []).map(toAvailableModel);
}

function toAvailableModel(m: FoundationModelSummary): AvailableModel {
  return {
    modelId: m.modelId ?? "",
    modelName: m.modelName,
    provider: m.providerName,
    // The control plane doesn't advertise tool-use support per model, so this is
    // inferred from the provider families known to support Converse tool use. It's
    // a hint for ordering a picker, not a capability assertion — hence the
    // conservative default of false for anything unrecognised.
    supportsToolUse: toolUseFamilies.some((f) => (m.modelId ?? "").includes(f)),
    supportsStreaming: (m.responseStreamingSupported ?? false) === true,
  };
}

/** Model-id substrings whose families support Converse tool use. */
const toolUseFamilies = ["anthropic.claude", "amazon.nova", "mistral.mistral-large", "cohere.command-r"];
