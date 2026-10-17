import { NativeAuthError } from "./types.js";

export async function fetchWithoutRedirect(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  expectedOrigin: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual" });
  } catch {
    throw new NativeAuthError("network", "The network request failed");
  }
  if (response.url) {
    let responseOrigin: string;
    try {
      responseOrigin = new URL(response.url).origin;
    } catch {
      throw new NativeAuthError("invalid_response", "The response URL is invalid");
    }
    if (responseOrigin !== expectedOrigin) {
      throw new NativeAuthError("invalid_response", "A cross-origin response was blocked");
    }
  }
  if (response.status >= 300 && response.status < 400) {
    throw new NativeAuthError("invalid_response", "A redirect response was blocked");
  }
  return response;
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new NativeAuthError("invalid_response", "The server response was not valid JSON");
  }
}
