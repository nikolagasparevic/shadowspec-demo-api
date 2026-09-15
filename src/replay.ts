export async function replayRequest(
  method: string,
  path: string,
  requestBody: unknown,
  pathParams: Record<string, string> = {}
) {
  const targetUrl =
    process.env.SHADOWSPEC_TARGET_URL ||
    "http://localhost:3001";

  let resolvedPath = path;

  for (const [key, value] of Object.entries(
    pathParams
  )) {
    resolvedPath = resolvedPath.replace(
      `:${key}`,
      encodeURIComponent(value)
    );
  }

  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json"
    }
  };

  if (
    method !== "GET" &&
    method !== "HEAD" &&
    requestBody !== null
  ) {
    options.body = JSON.stringify(requestBody);
  }

  const response = await fetch(
    `${targetUrl}${resolvedPath}`,
    options
  );

  const responseBody = await response.json();

  return {
    status: response.status,
    body: responseBody
  };
}