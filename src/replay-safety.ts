import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "./db";

export type ReplaySafetyErrorCode =
  | "REPLAY_OPT_IN_REQUIRED"
  | "REPLAY_SAFETY_CONFIG_MISSING"
  | "REPLAY_SAFETY_CONFIG_INVALID"
  | "REPLAY_DATABASE_NAME_MISMATCH"
  | "REPLAY_MARKER_TABLE_MISSING"
  | "REPLAY_MARKER_UNREADABLE"
  | "REPLAY_MARKER_ROW_MISSING"
  | "REPLAY_MARKER_INVALID"
  | "REPLAY_MARKER_VERSION_UNSUPPORTED"
  | "REPLAY_PROJECT_MISMATCH"
  | "REPLAY_DATABASE_ID_MISMATCH"
  | "REPLAY_TOKEN_MISMATCH"
  | "REPLAY_SAFETY_CHECK_FAILED";

export class ReplaySafetyError extends Error {
  readonly code: ReplaySafetyErrorCode;

  constructor(
    code: ReplaySafetyErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReplaySafetyError";
    this.code = code;
  }
}

export type ReplaySafetyConfig = Readonly<{
  projectId: string;
  replayDatabaseId: string;
  replayToken: string;
  replayDatabaseName: string;
}>;

export type ReplayPool = Pick<Pool, "connect">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORTED_MARKER_VERSION = 1;

function requiredValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];

  if (value === undefined || value.length === 0) {
    throw new ReplaySafetyError(
      "REPLAY_SAFETY_CONFIG_MISSING",
      `Replay safety configuration ${name} is required.`
    );
  }

  return value;
}

function validateUuid(value: string, name: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new ReplaySafetyError(
      "REPLAY_SAFETY_CONFIG_INVALID",
      `Replay safety configuration ${name} must be a valid UUID.`
    );
  }
}

export function parseReplaySafetyConfig(
  environment: NodeJS.ProcessEnv = process.env
): ReplaySafetyConfig {
  if (environment.SHADOWSPEC_REPLAY !== "true") {
    throw new ReplaySafetyError(
      "REPLAY_OPT_IN_REQUIRED",
      "Replay is disabled. Set SHADOWSPEC_REPLAY=true to allow guarded replay setup."
    );
  }

  const projectId = requiredValue(
    environment,
    "SHADOWSPEC_PROJECT_ID"
  );
  const replayDatabaseId = requiredValue(
    environment,
    "SHADOWSPEC_REPLAY_DATABASE_ID"
  );
  const replayToken = requiredValue(
    environment,
    "SHADOWSPEC_REPLAY_TOKEN"
  );
  const replayDatabaseName = requiredValue(
    environment,
    "SHADOWSPEC_REPLAY_DATABASE_NAME"
  );

  validateUuid(projectId, "SHADOWSPEC_PROJECT_ID");
  validateUuid(
    replayDatabaseId,
    "SHADOWSPEC_REPLAY_DATABASE_ID"
  );

  if (
    Buffer.byteLength(replayToken, "utf8") < 32 ||
    /[\u0000-\u001f\u007f]/.test(replayToken)
  ) {
    throw new ReplaySafetyError(
      "REPLAY_SAFETY_CONFIG_INVALID",
      "SHADOWSPEC_REPLAY_TOKEN must contain at least 32 bytes and no control characters."
    );
  }

  if (
    replayDatabaseName.trim() !== replayDatabaseName ||
    replayDatabaseName.length === 0 ||
    Buffer.byteLength(replayDatabaseName, "utf8") > 63 ||
    /[\u0000-\u001f\u007f]/.test(replayDatabaseName)
  ) {
    throw new ReplaySafetyError(
      "REPLAY_SAFETY_CONFIG_INVALID",
      "SHADOWSPEC_REPLAY_DATABASE_NAME is invalid."
    );
  }

  return Object.freeze({
    projectId: projectId.toLowerCase(),
    replayDatabaseId: replayDatabaseId.toLowerCase(),
    replayToken,
    replayDatabaseName
  });
}

type MarkerRow = {
  marker_version: unknown;
  project_id: unknown;
  replay_database_id: unknown;
  database_name: unknown;
  token_sha256: unknown;
};

function postgresCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function verifyReplayTarget(
  client: PoolClient,
  config: ReplaySafetyConfig,
  lockMarker: boolean
): Promise<void> {
  let databaseResult;

  try {
    databaseResult = await client.query<{
      database_name: string;
    }>(
      "SELECT current_database() AS database_name"
    );
  } catch (error) {
    throw new ReplaySafetyError(
      "REPLAY_SAFETY_CHECK_FAILED",
      "Replay database identity verification failed.",
      { cause: error }
    );
  }

  const currentDatabase =
    databaseResult.rows[0]?.database_name;

  if (currentDatabase !== config.replayDatabaseName) {
    throw new ReplaySafetyError(
      "REPLAY_DATABASE_NAME_MISMATCH",
      "The connected database does not match the authorized replay database name."
    );
  }

  let markerResult;

  try {
    markerResult = await client.query<MarkerRow>(
      `SELECT marker_version,
              project_id::text AS project_id,
              replay_database_id::text AS replay_database_id,
              database_name,
              token_sha256
       FROM shadowspec_internal.replay_target
       WHERE singleton_id = $1${
         lockMarker ? "\n       FOR SHARE" : ""
       }`,
      [1]
    );
  } catch (error) {
    const code = postgresCode(error);

    if (code === "42P01") {
      throw new ReplaySafetyError(
        "REPLAY_MARKER_TABLE_MISSING",
        "The replay authorization marker table is missing."
      );
    }

    if (code === "42501") {
      throw new ReplaySafetyError(
        "REPLAY_MARKER_UNREADABLE",
        "The replay authorization marker cannot be read."
      );
    }

    throw new ReplaySafetyError(
      "REPLAY_SAFETY_CHECK_FAILED",
      "Replay marker verification failed.",
      { cause: error }
    );
  }

  const marker = markerResult.rows[0];

  if (!marker) {
    throw new ReplaySafetyError(
      "REPLAY_MARKER_ROW_MISSING",
      "The replay authorization marker row is missing."
    );
  }

  if (
    typeof marker.marker_version !== "number" ||
    !Number.isInteger(marker.marker_version) ||
    typeof marker.project_id !== "string" ||
    typeof marker.replay_database_id !== "string" ||
    typeof marker.database_name !== "string" ||
    typeof marker.token_sha256 !== "string" ||
    !TOKEN_HASH_PATTERN.test(marker.token_sha256)
  ) {
    throw new ReplaySafetyError(
      "REPLAY_MARKER_INVALID",
      "The replay authorization marker is malformed."
    );
  }

  if (marker.marker_version !== SUPPORTED_MARKER_VERSION) {
    throw new ReplaySafetyError(
      "REPLAY_MARKER_VERSION_UNSUPPORTED",
      "The replay authorization marker version is unsupported."
    );
  }

  if (marker.database_name !== currentDatabase) {
    throw new ReplaySafetyError(
      "REPLAY_DATABASE_NAME_MISMATCH",
      "The replay marker does not authorize the connected database name."
    );
  }

  if (marker.project_id.toLowerCase() !== config.projectId) {
    throw new ReplaySafetyError(
      "REPLAY_PROJECT_MISMATCH",
      "The replay marker belongs to a different ShadowSpec project."
    );
  }

  if (
    marker.replay_database_id.toLowerCase() !==
    config.replayDatabaseId
  ) {
    throw new ReplaySafetyError(
      "REPLAY_DATABASE_ID_MISMATCH",
      "The replay marker has a different replay database identity."
    );
  }

  const actualHash = Buffer.from(
    marker.token_sha256,
    "hex"
  );
  const expectedHash = hashToken(config.replayToken);

  if (
    actualHash.length !== expectedHash.length ||
    !timingSafeEqual(actualHash, expectedHash)
  ) {
    throw new ReplaySafetyError(
      "REPLAY_TOKEN_MISMATCH",
      "The replay authorization token does not match the database marker."
    );
  }
}

function withRollbackContext(
  originalError: unknown,
  rollbackError: unknown
): unknown {
  if (originalError instanceof Error) {
    Object.defineProperty(
      originalError,
      "rollbackFailure",
      {
        configurable: true,
        enumerable: false,
        value: new Error(
          "Replay transaction rollback also failed.",
          { cause: rollbackError }
        )
      }
    );

    return originalError;
  }

  return new Error(
    "Replay failed and its transaction rollback also failed.",
    { cause: originalError }
  );
}

export async function runReplayTransaction<T>(
  replayPool: ReplayPool,
  config: ReplaySafetyConfig,
  readOnly: boolean,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await replayPool.connect();
  let transactionStarted = false;
  let discardClient = false;

  try {
    await client.query(
      readOnly ? "BEGIN READ ONLY" : "BEGIN"
    );
    transactionStarted = true;
    await verifyReplayTarget(
      client,
      config,
      !readOnly
    );
    const result = await operation(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    let failure: unknown = error;

    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discardClient = true;
        failure = withRollbackContext(
          failure,
          rollbackError
        );
      }
    }

    throw failure;
  } finally {
    client.release(discardClient);
  }
}

export async function preflightReplaySafety(
  replayPool: ReplayPool = pool,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = parseReplaySafetyConfig(environment);

  await runReplayTransaction(
    replayPool,
    config,
    true,
    async () => undefined
  );
}
