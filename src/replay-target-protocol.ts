import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

export const REPLAY_TARGET_PROTOCOL_VERSION = 1;
export const REPLAY_TARGET_ENDPOINT =
  "/__shadowspec/replay-target";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROOF_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeReplayTargetUuid(
  value: unknown
): string | undefined {
  return typeof value === "string" &&
    UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function isValidReplayTargetToken(
  value: unknown
): value is string {
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") >= 32 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function isValidReplayTargetNonce(
  value: unknown
): value is string {
  if (
    typeof value !== "string" ||
    !NONCE_PATTERN.test(value)
  ) {
    return false;
  }

  try {
    return Buffer.from(value, "base64url").length === 32;
  } catch {
    return false;
  }
}

export function buildReplayTargetProofInput(
  nonce: string,
  projectId: string,
  replayDatabaseId: string,
  replayTargetId: string
): string {
  return JSON.stringify([
    "shadowspec-replay-target",
    REPLAY_TARGET_PROTOCOL_VERSION,
    nonce,
    projectId,
    replayDatabaseId,
    replayTargetId
  ]);
}

export function computeReplayTargetProof(
  token: string,
  nonce: string,
  projectId: string,
  replayDatabaseId: string,
  replayTargetId: string
): string {
  return createHmac("sha256", token)
    .update(
      buildReplayTargetProofInput(
        nonce,
        projectId,
        replayDatabaseId,
        replayTargetId
      ),
      "utf8"
    )
    .digest("hex");
}

export function verifyReplayTargetProof(
  proof: unknown,
  expectedProof: string
): boolean {
  if (
    typeof proof !== "string" ||
    !PROOF_PATTERN.test(proof) ||
    !PROOF_PATTERN.test(expectedProof)
  ) {
    return false;
  }

  const actual = Buffer.from(proof, "hex");
  const expected = Buffer.from(
    expectedProof,
    "hex"
  );

  return actual.length === expected.length &&
    timingSafeEqual(actual, expected);
}
