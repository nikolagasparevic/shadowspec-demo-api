import { pool } from "./db";

export async function recordApiRequest(
  method: string,
  path: string,
  requestBody: unknown,
  responseStatus: number,
  responseBody: unknown
) {
  await pool.query(
    `INSERT INTO api_requests
      (method, path, request_body, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      method,
      path,
      JSON.stringify(requestBody),
      responseStatus,
      JSON.stringify(responseBody)
    ]
  );
}