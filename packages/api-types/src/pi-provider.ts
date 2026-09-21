export type PiCredentialSource = "stored" | "environment" | "none";

export interface PiProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  credentialSource: PiCredentialSource;
  storedCredentialType?: "api_key" | "oauth";
  externalSource?: string;
  modelCount: number;
}

export interface PiDiscoveredModel {
  qualifiedModelId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  reasoning: boolean;
}

export type PiCatalogStatus = "models-available" | "no-models" | "discovery-failed";

export interface PiSettingsStatus {
  providers: PiProviderStatus[];
  models: PiDiscoveredModel[];
  catalogStatus: PiCatalogStatus;
  liveValidity: "not-verified";
  discoveryFailedProviders: string[];
}

export interface PiCredentialMutationResult {
  credentialPersisted: boolean;
  synchronizationSucceeded: boolean;
  status: PiSettingsStatus;
}
