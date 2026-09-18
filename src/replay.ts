import {
  ReplayTargetSafetyError,
  verifyReplayTarget
} from "./replay-target-safety";

const INVALID_REQUEST_URL_MESSAGE =
  "Scenario request URL is not confined to the verified replay target.";

export function buildReplayTargetRequestUrl(
  targetOrigin: string,
  resolvedPath: string
): string {
  if (
    !resolvedPath.startsWith("/") ||
    resolvedPath.startsWith("//") ||
    resolvedPath.startsWith("/@") ||
    resolvedPath.includes("\\") ||
    resolvedPath.includes("#")
  ) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_REQUEST_URL_INVALID",
      INVALID_REQUEST_URL_MESSAGE
    );
  }

  let target: URL;
  let requestUrl: URL;

  try {
    target = new URL(targetOrigin);
    requestUrl = new URL(resolvedPath, target);
  } catch {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_REQUEST_URL_INVALID",
      INVALID_REQUEST_URL_MESSAGE
    );
  }

  if (
    requestUrl.origin !== target.origin ||
    requestUrl.username !== "" ||
    requestUrl.password !== "" ||
    requestUrl.hash !== ""
  ) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_REQUEST_URL_INVALID",
      INVALID_REQUEST_URL_MESSAGE
    );
  }

  return requestUrl.href;
}

export async function replayRequest(
  method: string,
  path: string,
  requestBody: unknown,
  pathParams: Record<string, string> = {},
  queryParams: Record<string, string> = {}
) {
  const { targetOrigin } =
    await verifyReplayTarget();

  let resolvedPath = path;

  for (const [key, value] of Object.entries(
    pathParams
  )) {
    resolvedPath = resolvedPath.replace(
      `:${key}`,
      encodeURIComponent(value)
    );
  }

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(
    queryParams
  )) {
    searchParams.set(key, value);
  }

  const queryString = searchParams.toString();

  if (queryString) {
    resolvedPath += `?${queryString}`;
  }

  const options: RequestInit = {
    method,
    redirect: "manual"
  };

  if (
    method !== "GET" &&
    method !== "HEAD" &&
    requestBody !== null
  ) {
    options.headers = {
      "Content-Type": "application/json"
    };

    options.body = JSON.stringify(requestBody);
  }

  const response = await fetch(
    buildReplayTargetRequestUrl(
      targetOrigin,
      resolvedPath
    ),
    options
  );

  const responseBody = await response.json();

  return {
    status: response.status,
    body: responseBody
  };
}
