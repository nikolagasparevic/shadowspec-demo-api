export async function replayRequest(
  method: string,
  path: string,
  requestBody: unknown
) {
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json"
    }
  };

  if (method !== "GET" && method !== "HEAD" && requestBody !== null) {
    options.body = JSON.stringify(requestBody);
  }

  const response = await fetch(
    `http://localhost:3001${path}`,
    options
  );

  const responseBody = await response.json();

  return {
    status: response.status,
    body: responseBody
  };
}