import type {
  FastifyInstance
} from "fastify";
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

export async function registerShadowSpecAgent(
  app: FastifyInstance
) {
  const enabled =
    process.env.SHADOWSPEC_CAPTURE === "true";

  if (!enabled) {
    return;
  }

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
        await captureDatabaseSnapshot();

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