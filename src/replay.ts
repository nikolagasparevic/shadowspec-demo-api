export async function replayRequest(
  method: string,
  path: string,
  requestBody: unknown
) {
  const response = await fetch(`http://localhost:3001${path}`, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const responseBody = await response.json();

  return {
    status: response.status,
    body: responseBody
  };
}