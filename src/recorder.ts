import type { Pool, PoolClient } from "pg";
import { CaptureDeadline } from "./capture-deadline";
import type { DatabaseSnapshot } from "./db-snapshot";

export type CaptureRecordErrorCode =
  | "CAPTURE_RECORD_TIMEOUT"
  | "CAPTURE_CLEANUP_FAILED";

type CaptureRecordStage =
  | "recorder-connect"
  | "recorder-transaction"
  | "recorder-insert"
  | "recorder-commit"
  | "recorder-cleanup";

export class CaptureRecordError extends Error {
  readonly name = "CaptureRecordError";

  constructor(
    readonly code: CaptureRecordErrorCode,
    message: string,
    readonly stage: CaptureRecordStage,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type CaptureRecordOptions = {
  timeoutMs?: number;
};

const DEFAULT_RECORDER_TIMEOUT_MS = 5_000;

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_RECORDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new CaptureRecordError(
      "CAPTURE_RECORD_TIMEOUT",
      "ShadowSpec recorder timeout configuration is invalid.",
      "recorder-connect"
    );
  }
  return timeout;
}

function discardClient(client: PoolClient, error: Error): void {
  try {
    client.release(error);
  } catch {
    // The client is already unusable; preserve the recorder failure.
  }
}

export async function recordApiRequest(
  capturePool: Pool,
  method: string,
  path: string,
  requestBody: unknown,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
  responseStatus: number,
  responseBody: unknown,
  snapshot: DatabaseSnapshot,
  sessionId?: string,
  options: CaptureRecordOptions = {}
) {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const deadline = new CaptureDeadline<CaptureRecordStage, CaptureRecordError>(
    timeoutMs,
    (stage) => new CaptureRecordError(
      "CAPTURE_RECORD_TIMEOUT",
      "ShadowSpec recorder timed out.",
      stage
    )
  );
  let client: PoolClient;

  client = await deadline.run(
    () => capturePool.connect(),
    "recorder-connect",
    (lateClient, error) => discardClient(lateClient, error)
  );

  let released = false;
  let stage: CaptureRecordStage = "recorder-transaction";
  try {
    await deadline.run(
      () => client.query("BEGIN").then(() => undefined),
      stage
    );
    const statementTimeout = deadline.remainingMilliseconds();
    if (statementTimeout < 1) throw deadline.timeout(stage);
    await deadline.run(
      () => client.query(
        `SET LOCAL statement_timeout = '${statementTimeout}ms'`
      ).then(() => undefined),
      stage
    );

    const serializedPathParams = JSON.stringify(pathParams);
    const serializedQueryParams = JSON.stringify(queryParams);
    const serializedRequestBody = JSON.stringify(requestBody);
    const serializedResponseBody = JSON.stringify(responseBody);
    const serializedSnapshot = JSON.stringify(snapshot);
    if (deadline.expired) throw deadline.timeout("recorder-insert");

    stage = "recorder-insert";
    const requestResult = await deadline.run(
      () => client.query(
        `INSERT INTO api_requests
          (
            method, path, path_params, query_params, request_body,
            response_status, response_body, session_id
          )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          method,
          path,
          serializedPathParams,
          serializedQueryParams,
          serializedRequestBody,
          responseStatus,
          serializedResponseBody,
          sessionId ?? null
        ]
      ),
      stage
    );

    const apiRequestId = requestResult.rows[0].id;
    await deadline.run(
      () => client.query(
        `INSERT INTO api_request_snapshots
          (api_request_id, snapshot)
         VALUES ($1, $2)`,
        [apiRequestId, serializedSnapshot]
      ).then(() => undefined),
      stage
    );

    stage = "recorder-commit";
    await deadline.run(
      () => client.query("COMMIT").then(() => undefined),
      stage
    );
  } catch (error) {
    const failure = deadline.expired
      ? deadline.timeout(stage)
      : error;
    if (
      failure instanceof CaptureRecordError &&
      failure.code === "CAPTURE_RECORD_TIMEOUT"
    ) {
      discardClient(client, failure);
      released = true;
      throw failure;
    }

    stage = "recorder-cleanup";
    try {
      await deadline.run(
        () => client.query("ROLLBACK").then(() => undefined),
        stage
      );
    } catch (rollbackError) {
      const cleanupFailure = deadline.expired
        ? deadline.timeout(stage)
        : new CaptureRecordError(
            "CAPTURE_CLEANUP_FAILED",
            "ShadowSpec recorder cleanup failed.",
            stage,
            { cause: rollbackError }
          );
      discardClient(client, cleanupFailure);
      released = true;
      throw cleanupFailure;
    }
    throw failure;
  } finally {
    if (!released) client.release();
  }
}
