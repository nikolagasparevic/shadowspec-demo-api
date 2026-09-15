import type { FastifyInstance } from "fastify";
import { recordApiRequest } from "./recorder";

export async function registerShadowSpecAgent(
  app: FastifyInstance
) {
  const enabled =
    process.env.SHADOWSPEC_CAPTURE === "true";

  if (!enabled) {
    return;
  }

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
        request.url,
        request.body ?? null,
        reply.statusCode,
        responseBody
      );

      return payload;
    }
  );

  app.log.info(
    "ShadowSpec Agent enabled"
  );
}