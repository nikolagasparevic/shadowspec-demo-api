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
};

function getConfiguredTables(): string[] {
  return (
    process.env.SHADOWSPEC_TABLES ?? ""
  )
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
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
      const snapshot =
        await captureDatabaseSnapshot(
          applicationPool,
          tables
        );

      const sessionId =
        request.headers[
          "x-shadowspec-session-id"
        ];

      request.shadowSpecSnapshot =
        snapshot;

      request.shadowSpecSessionId =
        typeof sessionId === "string"
          ? sessionId
          : undefined;
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
        throw new Error(
          "ShadowSpec snapshot is missing."
        );
      }

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

      return payload;
    }
  );

  app.log.info(
    "ShadowSpec Agent enabled"
  );
}
