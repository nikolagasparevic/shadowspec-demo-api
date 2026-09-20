import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE =
  "shadowspec.config.json";

export type ShadowSpecConfig = {
  schema: string;
  tables: string[];
  capture: {
    enabled: boolean;
  };
  privacy: {
    snapshotAllowedColumns: Record<
      string,
      string[]
    >;
  };
};

export class ConfigError extends Error {
  readonly name = "ConfigError";

  constructor(
    readonly code:
      | "CONFIG_NOT_FOUND"
      | "CONFIG_INVALID_JSON"
      | "CONFIG_INVALID_SCHEMA"
      | "CONFIG_INVALID_TABLES"
      | "CONFIG_INVALID_CAPTURE"
      | "CONFIG_INVALID_PRIVACY",
    message: string
  ) {
    super(message);
  }
}

function isRecord(
  value: unknown
): value is Record<
  string,
  unknown
> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateStringArray(
  value: unknown
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().length > 0
    )
  );
}

export function validateConfig(
  value: unknown
): ShadowSpecConfig {
  if (!isRecord(value)) {
    throw new ConfigError(
      "CONFIG_INVALID_JSON",
      "ShadowSpec config must be a JSON object."
    );
  }

  const schema =
    value.schema;

  if (
    typeof schema !== "string" ||
    schema.trim().length === 0
  ) {
    throw new ConfigError(
      "CONFIG_INVALID_SCHEMA",
      "schema must be a non-empty string."
    );
  }

  const tables =
    value.tables;

  if (
    !validateStringArray(
      tables
    )
  ) {
    throw new ConfigError(
      "CONFIG_INVALID_TABLES",
      "tables must be an array of non-empty strings."
    );
  }

  const capture =
    value.capture;

  if (
    !isRecord(capture) ||
    typeof capture.enabled !==
      "boolean"
  ) {
    throw new ConfigError(
      "CONFIG_INVALID_CAPTURE",
      "capture.enabled must be a boolean."
    );
  }

  const privacy =
    value.privacy;

  if (
    !isRecord(privacy) ||
    !isRecord(
      privacy.snapshotAllowedColumns
    )
  ) {
    throw new ConfigError(
      "CONFIG_INVALID_PRIVACY",
      "privacy.snapshotAllowedColumns must be an object."
    );
  }

  const snapshotAllowedColumns:
    Record<
      string,
      string[]
    > = {};

  for (
    const [
      table,
      columns
    ] of Object.entries(
      privacy.snapshotAllowedColumns
    )
  ) {
    if (
      table.trim().length === 0 ||
      !validateStringArray(
        columns
      )
    ) {
      throw new ConfigError(
        "CONFIG_INVALID_PRIVACY",
        "privacy.snapshotAllowedColumns must map non-empty table names to arrays of non-empty strings."
      );
    }

    snapshotAllowedColumns[
      table
    ] = columns;
  }

  return {
    schema,
    tables,
    capture: {
      enabled: capture.enabled
    },
    privacy: {
      snapshotAllowedColumns
    }
  };
}

export function loadConfig(
  cwd = process.cwd()
): ShadowSpecConfig {
  const configPath =
    path.join(
      cwd,
      CONFIG_FILE
    );

  if (
    !fs.existsSync(
      configPath
    )
  ) {
    throw new ConfigError(
      "CONFIG_NOT_FOUND",
      `${CONFIG_FILE} was not found.`
    );
  }

  let parsed: unknown;

  try {
    parsed =
      JSON.parse(
        fs.readFileSync(
          configPath,
          "utf8"
        )
      );
  } catch {
    throw new ConfigError(
      "CONFIG_INVALID_JSON",
      `${CONFIG_FILE} is not valid JSON.`
    );
  }

  return validateConfig(
    parsed
  );
}