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

  return {
    errorName,
    ...(errorCode === undefined
      ? {}
      : { errorCode })
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

  const applicationPool =
    options.applicationPool;
  const capturePool =
    options.capturePool ?? applicationPool;
  const tables = [
    ...(options.tables ??
      getConfiguredTables())
  ];
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
                snapshotStatementTimeoutMs
            }
          );
      } catch (error) {
        request.shadowSpecSnapshot =
          undefined;
        request.log.error(
          getCaptureErrorDetails(error),
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
          request.shadowSpecSessionId
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
