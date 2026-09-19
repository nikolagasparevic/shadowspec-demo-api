import type { Pool, PoolClient } from "pg";
import { pool } from "./db";

export type PersistedCapture = {
  id: unknown;
  active: unknown;
  sessionId: unknown;
  method: unknown;
  path: unknown;
  pathParams: unknown;
  queryParams: unknown;
  requestBody: unknown;
  responseBody: unknown;
  responseStatus: unknown;
  snapshots: unknown[];
};

export type FrozenCaptureSet = {
  maxVisibleCaptureId: number | null;
  captures: PersistedCapture[];
};

export type CaptureExportPool = Pick<Pool, "connect">;

type CaptureRow = {
  id: unknown;
  active: unknown;
  session_id: unknown;
  method: unknown;
  path: unknown;
  path_params: unknown;
  query_params: unknown;
  request_body: unknown;
  response_body: unknown;
  response_status: unknown;
  snapshot_id: unknown;
  snapshot: unknown;
};

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original export read failure.
  }
}

export async function loadFrozenCaptureSet(
  capturePool: CaptureExportPool = pool
): Promise<FrozenCaptureSet> {
  const client = await capturePool.connect();
  try {
    await client.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    const maximum = await client.query<{ max_id: number | string | null }>(
      "SELECT MAX(id) AS max_id FROM api_requests"
    );
    const maximumValue = maximum.rows[0]?.max_id ?? null;
    const maxVisibleCaptureId = maximumValue === null
      ? null
      : Number(maximumValue);
    if (
      maxVisibleCaptureId !== null &&
      (!Number.isSafeInteger(maxVisibleCaptureId) || maxVisibleCaptureId < 1)
    ) {
      throw new Error("ShadowSpec capture watermark is invalid.");
    }

    const result = maxVisibleCaptureId === null
      ? { rows: [] as CaptureRow[] }
      : await client.query<CaptureRow>(
          `SELECT
             r.id,
             r.active,
             r.session_id,
             r.method,
             r.path,
             r.path_params,
             r.query_params,
             r.request_body,
             r.response_body,
             r.response_status,
             s.id AS snapshot_id,
             s.snapshot
           FROM api_requests r
           LEFT JOIN api_request_snapshots s
             ON s.api_request_id = r.id
           WHERE r.id <= $1
           ORDER BY r.id ASC, s.id ASC`,
          [maxVisibleCaptureId]
        );

    const captures = new Map<number, PersistedCapture>();
    for (const row of result.rows) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error("ShadowSpec persisted capture ID is invalid.");
      }
      let capture = captures.get(id);
      if (!capture) {
        capture = {
          id,
          active: row.active,
          sessionId: row.session_id,
          method: row.method,
          path: row.path,
          pathParams: row.path_params,
          queryParams: row.query_params,
          requestBody: row.request_body,
          responseBody: row.response_body,
          responseStatus: row.response_status,
          snapshots: []
        };
        captures.set(id, capture);
      }
      if (row.snapshot_id !== null && row.snapshot_id !== undefined) {
        capture.snapshots.push(row.snapshot);
      }
    }
    await client.query("COMMIT");
    return {
      maxVisibleCaptureId,
      captures: [...captures.values()]
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
