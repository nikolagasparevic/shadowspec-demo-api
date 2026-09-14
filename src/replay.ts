export async function replayRequest(
  method: string,
  path: string,
  requestBody: unknown
) {
  const targetUrl =
    process.env.SHADOWSPEC_TARGET_URL || "http://localhost:3001";


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
    `${targetUrl}${path}`,
    options
  );

  const responseBody = await response.json();

  return {
    status: response.status,
    body: responseBody
  };
}