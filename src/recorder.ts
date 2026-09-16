import { pool } from "./db";
import type { DatabaseSnapshot } from "./db-snapshot";

export async function recordApiRequest(
  method: string,
  path: string,
  requestBody: unknown,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
  responseStatus: number,
  responseBody: unknown,
  snapshot: DatabaseSnapshot
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestResult = await client.query(
      `INSERT INTO api_requests
        (
          method,
          path,
          path_params,
          query_params,
          request_body,
          response_status,
          response_body
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        method,
        path,
        JSON.stringify(pathParams),
        JSON.stringify(queryParams),
        JSON.stringify(requestBody),
        responseStatus,
        JSON.stringify(responseBody)
      ]
    );

    const apiRequestId =
      requestResult.rows[0].id;

    await client.query(
      `INSERT INTO api_request_snapshots
        (api_request_id, snapshot)
       VALUES ($1, $2)`,
      [
        apiRequestId,
        JSON.stringify(snapshot)
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}