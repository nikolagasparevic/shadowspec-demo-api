import type { FastifyInstance } from "fastify";
import { recordApiRequest } from "./recorder";
import { captureDatabaseSnapshot } from "./db-snapshot";

export async function registerShadowSpecAgent(
  app: FastifyInstance
) {
  const enabled =
    process.env.SHADOWSPEC_CAPTURE === "true";

  if (!enabled) {
    return;
  }

  app.addHook(
    "preHandler",
    async (request) => {
      const snapshot =
        await captureDatabaseSnapshot();

      const sessionId =
        request.headers[
          "x-shadowspec-session-id"
        ];

      (request as any).shadowSpecSnapshot =
        snapshot;

      (request as any).shadowSpecSessionId =
        typeof sessionId === "string"
          ? sessionId
          : undefined;
    }
  );

  app.addHook(
    "onSend",
    async (request, reply, payload) => {
      let responseBody: unknown = payload;

      if (typeof payload === "string") {
        try {
          responseBody = JSON.parse(payload);
        } catch {
          responseBody = payload;
        }
      }

      await recordApiRequest(
        request.method,
        request.url.split("?")[0],
        request.body ?? null,
        request.params as Record<string, string>,
        request.query as Record<string, string>,
        reply.statusCode,
        responseBody,
        (request as any)
          .shadowSpecSnapshot,
        (request as any)
          .shadowSpecSessionId
      );

      return payload;
    }
  );

  app.log.info(
    "ShadowSpec Agent enabled"
  );
}