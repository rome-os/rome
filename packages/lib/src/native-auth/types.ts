export interface CloudCredential {
  accessToken: string;
  deviceSessionId: string;
}

export interface InstanceSession {
  cookieName: "rome_session";
  token: string;
  expiresAt: string;
  origin: string;
}

export interface CloudInstance {
  id: string;
  name: string;
  slug: string;
  origin: string;
  status: string;
}

export interface InstanceAuthorizationRequest {
  response_type: "code";
  client_id: "rome-instance";
  redirect_uri: string;
  scope: "openid";
  state: string;
  code_challenge: string;
  code_challenge_method: "S256";
  nonce: string;
}

export interface CloudInstanceAuthorization {
  code: string;
  state: string;
  iss: string;
  expires_in: number;
}

export type NativeAuthErrorCode =
  | "access_denied"
  | "cancelled"
  | "cloud_unauthorized"
  | "invalid_response"
  | "instance_not_ready"
  | "network"
  | "session_rejected";

export class NativeAuthError extends Error {
  constructor(
    readonly code: NativeAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NativeAuthError";
  }
}
