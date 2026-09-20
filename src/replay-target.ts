import type { FastifyInstance } from "fastify";
import {
  computeReplayTargetProof,
  isValidReplayTargetNonce,
  isValidReplayTargetToken,
  normalizeReplayTargetUuid,
  REPLAY_TARGET_ENDPOINT,
  REPLAY_TARGET_PROTOCOL_VERSION
} from "./replay-target-protocol";

export type ShadowSpecReplayTargetOptions = {
  enabled?: boolean;
  projectId?: string;
  replayDatabaseId?: string;
  replayTargetId?: string;
  token?: string;
};

function requiredIdentity(
  value: unknown,
  name: string
): string {
  if (value === undefined || value === "") {
    throw new Error(
      `ShadowSpec replay-target configuration ${name} is required.`
    );
  }

  const normalized =
    normalizeReplayTargetUuid(value);

  if (!normalized) {
    throw new Error(
      `ShadowSpec replay-target configuration ${name} must be a valid UUID.`
    );
  }

  return normalized;
}

export function registerShadowSpecReplayTarget(
  app: FastifyInstance,
  options: ShadowSpecReplayTargetOptions = {}
): void {
  if (
    options.enabled !== undefined &&
    typeof options.enabled !== "boolean"
  ) {
    throw new Error(
      "ShadowSpec replay-target configuration enabled must be a boolean."
    );
  }

  const enabled =
    options.enabled ??
    process.env.SHADOWSPEC_REPLAY_TARGET ===
      "true";

  if (!enabled) {
    return;
  }

  const projectId = requiredIdentity(
    options.projectId ??
      process.env.SHADOWSPEC_PROJECT_ID,
    "projectId"
  );
  const replayDatabaseId = requiredIdentity(
    options.replayDatabaseId ??
      process.env.SHADOWSPEC_REPLAY_DATABASE_ID,
    "replayDatabaseId"
  );
  const replayTargetId = requiredIdentity(
    options.replayTargetId ??
      process.env.SHADOWSPEC_REPLAY_TARGET_ID,
    "replayTargetId"
  );
  const token = options.token ??
    process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN;

  if (token === undefined || token === "") {
    throw new Error(
      "ShadowSpec replay-target configuration token is required."
    );
  }

  if (!isValidReplayTargetToken(token)) {
    throw new Error(
      "ShadowSpec replay-target configuration token must contain at least 32 bytes and no control characters."
    );
  }

  app.post(
    REPLAY_TARGET_ENDPOINT,
    {
      logLevel: "silent"
    },
    async (request, reply) => {
      const body = request.body;

      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !("protocolVersion" in body) ||
        !("nonce" in body) ||
        body.protocolVersion !==
          REPLAY_TARGET_PROTOCOL_VERSION ||
        !isValidReplayTargetNonce(body.nonce)
      ) {
        return reply.code(400).send({
          error: "Invalid ShadowSpec replay-target challenge."
        });
      }

      const proof = computeReplayTargetProof(
        token,
        body.nonce,
        projectId,
        replayDatabaseId,
        replayTargetId
      );

      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send({
          protocolVersion:
            REPLAY_TARGET_PROTOCOL_VERSION,
          projectId,
          replayDatabaseId,
          replayTargetId,
          proof
        });
    }
  );
}
