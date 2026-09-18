import { randomBytes } from "node:crypto";
import {
  computeReplayTargetProof,
  isValidReplayTargetToken,
  normalizeReplayTargetUuid,
  REPLAY_TARGET_ENDPOINT,
  REPLAY_TARGET_PROTOCOL_VERSION,
  verifyReplayTargetProof
} from "./replay-target-protocol";

export type ReplayTargetSafetyErrorCode =
  | "REPLAY_TARGET_CONFIG_MISSING"
  | "REPLAY_TARGET_CONFIG_INVALID"
  | "REPLAY_TARGET_URL_INVALID"
  | "REPLAY_TARGET_REQUEST_URL_INVALID"
  | "REPLAY_TARGET_UNREACHABLE"
  | "REPLAY_TARGET_TIMEOUT"
  | "REPLAY_TARGET_REDIRECT_REFUSED"
  | "REPLAY_TARGET_HANDSHAKE_MISSING"
  | "REPLAY_TARGET_HANDSHAKE_REJECTED"
  | "REPLAY_TARGET_RESPONSE_INVALID"
  | "REPLAY_TARGET_PROTOCOL_UNSUPPORTED"
  | "REPLAY_TARGET_PROJECT_MISMATCH"
  | "REPLAY_TARGET_DATABASE_ID_MISMATCH"
  | "REPLAY_TARGET_ID_MISMATCH"
  | "REPLAY_TARGET_PROOF_INVALID";

export class ReplayTargetSafetyError extends Error {
  readonly code: ReplayTargetSafetyErrorCode;

  constructor(
    code: ReplayTargetSafetyErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ReplayTargetSafetyError";
    this.code = code;
  }
}

export type ReplayTargetSafetyConfig = Readonly<{
  targetOrigin: string;
  projectId: string;
  replayDatabaseId: string;
  replayTargetId: string;
  token: string;
}>;

const MAX_HANDSHAKE_RESPONSE_BYTES = 8 * 1024;
const HANDSHAKE_TIMEOUT_MS = 3_000;

function requiredValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];

  if (value === undefined || value === "") {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_CONFIG_MISSING",
      `Replay target safety configuration ${name} is required.`
    );
  }

  return value;
}

function requiredUuid(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = requiredValue(environment, name);
  const normalized =
    normalizeReplayTargetUuid(value);

  if (!normalized) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_CONFIG_INVALID",
      `Replay target safety configuration ${name} must be a valid UUID.`
    );
  }

  return normalized;
}

function parseTargetOrigin(value: string): string {
  let target: URL;

  try {
    target = new URL(value);
  } catch {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_URL_INVALID",
      "SHADOWSPEC_TARGET_URL must be an absolute HTTP or HTTPS origin."
    );
  }

  if (
    (target.protocol !== "http:" &&
      target.protocol !== "https:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== "" ||
    (target.pathname !== "" &&
      target.pathname !== "/")
  ) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_URL_INVALID",
      "SHADOWSPEC_TARGET_URL must be an absolute HTTP or HTTPS origin without credentials, path, query, or fragment."
    );
  }

  return target.origin;
}

export function parseReplayTargetSafetyConfig(
  environment: NodeJS.ProcessEnv = process.env
): ReplayTargetSafetyConfig {
  const targetOrigin = parseTargetOrigin(
    requiredValue(
      environment,
      "SHADOWSPEC_TARGET_URL"
    )
  );
  const projectId = requiredUuid(
    environment,
    "SHADOWSPEC_PROJECT_ID"
  );
  const replayDatabaseId = requiredUuid(
    environment,
    "SHADOWSPEC_REPLAY_DATABASE_ID"
  );
  const replayTargetId = requiredUuid(
    environment,
    "SHADOWSPEC_REPLAY_TARGET_ID"
  );
  const token = requiredValue(
    environment,
    "SHADOWSPEC_REPLAY_TARGET_TOKEN"
  );

  if (!isValidReplayTargetToken(token)) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_CONFIG_INVALID",
      "SHADOWSPEC_REPLAY_TARGET_TOKEN must contain at least 32 bytes and no control characters."
    );
  }

  return Object.freeze({
    targetOrigin,
    projectId,
    replayDatabaseId,
    replayTargetId,
    token
  });
}

async function readBoundedResponse(
  response: Response
): Promise<string> {
  const contentLength = response.headers.get(
    "content-length"
  );

  if (
    contentLength !== null &&
    Number(contentLength) >
      MAX_HANDSHAKE_RESPONSE_BYTES
  ) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_RESPONSE_INVALID",
      "Replay target handshake response exceeded the size limit."
    );
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > MAX_HANDSHAKE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_RESPONSE_INVALID",
        "Replay target handshake response exceeded the size limit."
      );
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

type HandshakeResponse = {
  protocolVersion: number;
  projectId: string;
  replayDatabaseId: string;
  replayTargetId: string;
  proof: string;
};

function parseHandshakeResponse(
  body: string
): HandshakeResponse {
  let value: unknown;

  try {
    value = JSON.parse(body);
  } catch {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_RESPONSE_INVALID",
      "Replay target returned an invalid handshake response."
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !("protocolVersion" in value) ||
    !("projectId" in value) ||
    !("replayDatabaseId" in value) ||
    !("replayTargetId" in value) ||
    !("proof" in value) ||
    typeof value.protocolVersion !== "number" ||
    typeof value.projectId !== "string" ||
    typeof value.replayDatabaseId !== "string" ||
    typeof value.replayTargetId !== "string" ||
    typeof value.proof !== "string"
  ) {
    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_RESPONSE_INVALID",
      "Replay target returned an invalid handshake response."
    );
  }

  return value as HandshakeResponse;
}

export async function verifyReplayTarget(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  nonce = randomBytes(32).toString("base64url")
): Promise<ReplayTargetSafetyConfig> {
  const config =
    parseReplayTargetSafetyConfig(environment);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );
  let responseReceived = false;

  try {
    const response = await fetchImplementation(
      `${config.targetOrigin}${REPLAY_TARGET_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          protocolVersion:
            REPLAY_TARGET_PROTOCOL_VERSION,
          nonce
        }),
        redirect: "manual",
        signal: controller.signal
      }
    );
    responseReceived = true;

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_REDIRECT_REFUSED",
        "Replay target handshake redirect was refused."
      );
    }

    if (response.status === 404) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_HANDSHAKE_MISSING",
        "Replay target handshake endpoint is missing."
      );
    }

    if (!response.ok) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_HANDSHAKE_REJECTED",
        "Replay target rejected the handshake."
      );
    }

    const handshake = parseHandshakeResponse(
      await readBoundedResponse(response)
    );

    if (
      handshake.protocolVersion !==
      REPLAY_TARGET_PROTOCOL_VERSION
    ) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_PROTOCOL_UNSUPPORTED",
        "Replay target protocol version is unsupported."
      );
    }

    const projectId = normalizeReplayTargetUuid(
      handshake.projectId
    );
    const replayDatabaseId =
      normalizeReplayTargetUuid(
        handshake.replayDatabaseId
      );
    const replayTargetId =
      normalizeReplayTargetUuid(
        handshake.replayTargetId
      );

    if (
      !projectId ||
      !replayDatabaseId ||
      !replayTargetId
    ) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_RESPONSE_INVALID",
        "Replay target returned an invalid handshake response."
      );
    }

    if (projectId !== config.projectId) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_PROJECT_MISMATCH",
        "Replay target belongs to a different ShadowSpec project."
      );
    }

    if (
      replayDatabaseId !== config.replayDatabaseId
    ) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_DATABASE_ID_MISMATCH",
        "Replay target has a different replay database identity."
      );
    }

    if (replayTargetId !== config.replayTargetId) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_ID_MISMATCH",
        "Replay target identity does not match."
      );
    }

    const expectedProof = computeReplayTargetProof(
      config.token,
      nonce,
      config.projectId,
      config.replayDatabaseId,
      config.replayTargetId
    );

    if (
      !verifyReplayTargetProof(
        handshake.proof,
        expectedProof
      )
    ) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_PROOF_INVALID",
        "Replay target proof is invalid."
      );
    }

    return config;
  } catch (error) {
    if (error instanceof ReplayTargetSafetyError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_TIMEOUT",
        "Replay target handshake timed out."
      );
    }

    if (!responseReceived) {
      throw new ReplayTargetSafetyError(
        "REPLAY_TARGET_UNREACHABLE",
        "Replay target could not be reached."
      );
    }

    throw new ReplayTargetSafetyError(
      "REPLAY_TARGET_RESPONSE_INVALID",
      "Replay target returned an invalid handshake response."
    );
  } finally {
    clearTimeout(timeout);
  }
}
