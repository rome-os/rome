class ConnectorApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function requiresComposioSignIn(error: unknown): boolean {
  return (
    error instanceof ConnectorApiError &&
    (error.code === "composio_unauthenticated" || error.code === "no_api_key")
  );
}

export async function readApiResponse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ConnectorApiError(body.message ?? fallback, body.error);
  }
  return response.json() as Promise<T>;
}
