export interface CloudCredential {
  accessToken: string;
  deviceSessionId: string;
}

/** `rome_session` for the guardian, `rome_visitor` for a dashboard admin. */
export type InstanceSessionCookie = "rome_session" | "rome_visitor";

export interface InstanceSession {
  cookieName: InstanceSessionCookie;
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
  /**
   * `owner`, or `visitor` for a Rome whose owner put this account on its
   * dashboard allow-list. An older Rome Cloud sends no role: the owner's.
   */
  role: "owner" | "visitor";
  /** The owner's display name, for a visitor's Rome. */
  ownerName?: string;
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

/**
 * The instance's request for a visitor sign-in, relayed to Rome Cloud as is.
 * Its code is identity-only and redeems only at the instance's visitor
 * endpoint, so no instance build can take it for the owner's.
 */
export interface VisitorAuthorizationRequest {
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string;
  instance_name: string;
  intent: "signin";
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
