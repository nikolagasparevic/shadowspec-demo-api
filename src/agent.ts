import type {
  FastifyInstance
} from "fastify";
import type { Pool } from "pg";
import type {
  DatabaseSnapshot
} from "./db-snapshot";
import {
  recordApiRequest
} from "./recorder";
import {
  captureDatabaseSnapshot
} from "./db-snapshot";
import { REPLAY_TARGET_ENDPOINT } from "./replay-target-protocol";
import {
  assertRequestPrivacy,
  assertResponsePrivacy,
  CapturePrivacyError,
  compileCapturePrivacyPolicy,
  type CapturePrivacyOptions
} from "./capture-privacy";

declare module "fastify" {
  interface FastifyRequest {
    shadowSpecSnapshot?:
      DatabaseSnapshot;
    shadowSpecSessionId?:
      string;
  }
}

export type ShadowSpecOptions = {
  applicationPool: Pool;
  capturePool?: Pool;
  tables?: readonly string[];
  enabled?: boolean;
  schema?: string;
  snapshotStatementTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  recorderTimeoutMs?: number;
  privacy?: CapturePrivacyOptions;
};

function getConfiguredTables(): string[] {
  return (
    process.env.SHADOWSPEC_TABLES ?? ""
  )
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
}

function getCaptureErrorDetails(
  error: unknown
): {
  errorName: string;
  errorCode?: string;
  errorStage?: string;
} {
  const errorName =
    error instanceof Error
      ? error.name
      : "UnknownError";
  const errorCode =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const errorStage =
    error !== null &&
    typeof error === "object" &&
    "stage" in error &&
    typeof error.stage === "string"
      ? error.stage
      : undefined;

  return {
    errorName,
    ...(errorCode === undefined
      ? {}
      : { errorCode }),
    ...(errorStage === undefined
      ? {}
      : { errorStage })
  };
}

function getPrivacyErrorDetails(
  error: CapturePrivacyError
) {
  return {
    errorName: error.name,
    errorCode: error.code,
    ...(error.location === undefined
      ? {}
      : { errorLocation: error.location }),
    ...(error.pointer === undefined
      ? {}
      : { errorPointer: error.pointer.slice(0, 256) }),
    ...(error.headerName === undefined
      ? {}
      : { errorHeader: error.headerName }),
    ...(error.tableName === undefined
      ? {}
      : { errorTable: error.tableName }),
    ...(error.columnName === undefined
      ? {}
      : { errorColumn: error.columnName })
  };
}

export function registerShadowSpec(
  app: FastifyInstance,
  options: ShadowSpecOptions
): void {
  const enabled =
    options.enabled ??
    process.env.SHADOWSPEC_CAPTURE === "true";

  if (!enabled) {
    return;
  }
  const tables = [
    ...(options.tables ??
      getConfiguredTables())
  ];

  let privacyPolicy;
  try {
    privacyPolicy = compileCapturePrivacyPolicy(options.privacy, tables);
  } catch (error) {
    const failure = error instanceof CapturePrivacyError
      ? error
      : new CapturePrivacyError(
          "CAPTURE_PRIVACY_CONFIGURATION_INVALID",
          "ShadowSpec privacy configuration is invalid."
        );
    app.log.error(
      getPrivacyErrorDetails(failure),
      "ShadowSpec capture disabled because its privacy configuration is invalid."
    );
    return;
  }

  const applicationPool =
    options.applicationPool;
  const capturePool =
    options.capturePool ?? applicationPool;
  const schema =
    options.schema ??
    process.env.SHADOWSPEC_SCHEMA ??
    "public";
  const configuredTimeout =
    process.env.SHADOWSPEC_SNAPSHOT_STATEMENT_TIMEOUT_MS;
  const snapshotStatementTimeoutMs =
    options.snapshotStatementTimeoutMs ??
    (configuredTimeout === undefined
      ? undefined
      : Number(configuredTimeout));
  const configuredSnapshotTimeout =
    process.env.SHADOWSPEC_SNAPSHOT_TIMEOUT_MS;
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ??
    (configuredSnapshotTimeout === undefined
      ? undefined
      : Number(configuredSnapshotTimeout));
  const configuredRecorderTimeout =
    process.env.SHADOWSPEC_RECORDER_TIMEOUT_MS;
  const recorderTimeoutMs =
    options.recorderTimeoutMs ??
    (configuredRecorderTimeout === undefined
      ? undefined
      : Number(configuredRecorderTimeout));

  app.decorateRequest(
    "shadowSpecSnapshot",
    undefined
  );

  app.decorateRequest(
    "shadowSpecSessionId",
    undefined
  );

  app.addHook(
    "preHandler",
    async (request) => {
      if (
        request.url.split("?")[0] ===
        REPLAY_TARGET_ENDPOINT
      ) {
        return;
      }

      try {
        assertRequestPrivacy(privacyPolicy, {
          headers: request.headers,
          body: request.body,
          query: request.query,
          pathParams: request.params
        });
      } catch (error) {
        if (!(error instanceof CapturePrivacyError)) throw error;
        request.shadowSpecSnapshot = undefined;
        request.log.error(
          getPrivacyErrorDetails(error),
          "ShadowSpec request capture rejected by its privacy policy."
        );
        return;
      }

      const sessionId =
        request.headers[
          "x-shadowspec-session-id"
        ];

      request.shadowSpecSessionId =
        typeof sessionId === "string"
          ? sessionId
          : undefined;

      try {
        request.shadowSpecSnapshot =
          await captureDatabaseSnapshot(
            applicationPool,
            tables,
            {
              schema,
              statementTimeoutMs:
                snapshotStatementTimeoutMs,
              snapshotTimeoutMs,
              snapshotAllowedColumns:
                privacyPolicy.snapshotAllowedColumns
            }
          );
      } catch (error) {
        request.shadowSpecSnapshot =
          undefined;
        request.log.error(
          error instanceof CapturePrivacyError
            ? getPrivacyErrorDetails(error)
            : getCaptureErrorDetails(error),
          "ShadowSpec snapshot capture failed; request will not be recorded."
        );
      }
    }
  );

  app.addHook(
    "onSend",
    async (
      request,
      reply,
      payload
    ) => {
      let responseBody: unknown =
        payload;

      if (typeof payload === "string") {
        try {
          responseBody =
            JSON.parse(payload);
        } catch {
          responseBody =
            payload;
        }
      }

      if (
        request.shadowSpecSnapshot ===
        undefined
      ) {
        return payload;
      }

      try {
        assertResponsePrivacy(privacyPolicy, responseBody);
      } catch (error) {
        if (!(error instanceof CapturePrivacyError)) throw error;
        request.log.error(
          getPrivacyErrorDetails(error),
          "ShadowSpec response capture rejected by its privacy policy."
        );
        return payload;
      }

      try {
        await recordApiRequest(
          capturePool,
          request.method,
          request.url.split("?")[0],
          request.body ?? null,
          request.params as Record<
            string,
            string
          >,
          request.query as Record<
            string,
            string
          >,
          reply.statusCode,
          responseBody,
          request.shadowSpecSnapshot,
          request.shadowSpecSessionId,
          { timeoutMs: recorderTimeoutMs }
        );
      } catch (error) {
        request.log.error(
          getCaptureErrorDetails(error),
          "ShadowSpec recorder write failed; response will be sent unchanged."
        );
      }

      return payload;
    }
  );

  app.log.info(
    "ShadowSpec Agent enabled"
  );
}
