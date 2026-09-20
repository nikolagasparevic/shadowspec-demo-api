import fs from "node:fs";
import path from "node:path";
import {
  detectDependencies
} from "./init";

type CheckStatus =
  | "PASS"
  | "REVIEW"
  | "FAIL";

type DoctorCheck = {
  label: string;
  status: CheckStatus;
  detail?: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type ShadowSpecConfig = {
  schema?: unknown;
  tables?: unknown;
  capture?: unknown;
  privacy?: {
    snapshotAllowedColumns?: unknown;
  };
};

export type DoctorResult = {
  checks: DoctorCheck[];
  passed: number;
  review: number;
  failed: number;
};

export class DoctorError extends Error {
  readonly name = "DoctorError";

  constructor(
    readonly code:
      | "DOCTOR_ARGUMENT_INVALID"
      | "DOCTOR_FAILED",
    message: string
  ) {
    super(message);
  }
}

function dependencyVersion(
  packageJson: PackageJson,
  name: string
): string | undefined {
  return (
    packageJson.dependencies?.[name] ??
    packageJson.devDependencies?.[name]
  );
}

function loadPackageJson(
  cwd: string
):
  | {
      packageJson: PackageJson;
    }
  | {
      error: string;
    } {
  const packagePath =
    path.join(
      cwd,
      "package.json"
    );

  if (!fs.existsSync(packagePath)) {
    return {
      error:
        "package.json was not found."
    };
  }

  try {
    const parsed =
      JSON.parse(
        fs.readFileSync(
          packagePath,
          "utf8"
        )
      ) as PackageJson;

    return {
      packageJson: parsed
    };
  } catch {
    return {
      error:
        "package.json is not valid JSON."
    };
  }
}

function loadConfig(
  cwd: string
):
  | {
      config: ShadowSpecConfig;
    }
  | {
      error: string;
    } {
  const configPath =
    path.join(
      cwd,
      "shadowspec.config.json"
    );

  if (!fs.existsSync(configPath)) {
    return {
      error:
        "shadowspec.config.json was not found."
    };
  }

  try {
    const parsed =
      JSON.parse(
        fs.readFileSync(
          configPath,
          "utf8"
        )
      ) as ShadowSpecConfig;

    return {
      config: parsed
    };
  } catch {
    return {
      error:
        "shadowspec.config.json is not valid JSON."
    };
  }
}

function hasApprovedSnapshotColumns(
  value: unknown
): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  return Object.values(
    value as Record<
      string,
      unknown
    >
  ).some(
    (columns) =>
      Array.isArray(columns) &&
      columns.length > 0 &&
      columns.every(
        (column) =>
          typeof column === "string" &&
          column.length > 0
      )
  );
}

export function runDoctor(
  cwd = process.cwd()
): DoctorResult {
  const checks: DoctorCheck[] = [];

  const packageResult =
    loadPackageJson(cwd);

  if ("error" in packageResult) {
    checks.push({
      label: "package.json",
      status: "FAIL",
      detail: packageResult.error
    });

    checks.push({
      label:
        "shadowspec dependency",
      status: "FAIL",
      detail:
        "Cannot inspect dependencies without a valid package.json."
    });

    checks.push({
      label:
        "fastify dependency",
      status: "FAIL",
      detail:
        "Cannot inspect dependencies without a valid package.json."
    });

    checks.push({
      label: "pg dependency",
      status: "FAIL",
      detail:
        "Cannot inspect dependencies without a valid package.json."
    });
  } else {
    const packageJson =
      packageResult.packageJson;

    const dependencies =
      detectDependencies(
        packageJson
      );

    checks.push({
      label: "package.json",
      status: "PASS"
    });

    checks.push({
      label:
        "shadowspec dependency",
      status:
        dependencies.shadowspec
          ? "PASS"
          : "FAIL",
      detail:
        dependencies.shadowspec
          ? dependencyVersion(
              packageJson,
              "shadowspec"
            )
          : "Run npm install shadowspec."
    });

    checks.push({
      label:
        "fastify dependency",
      status:
        dependencies.fastify
          ? "PASS"
          : "FAIL",
      detail:
        dependencies.fastify
          ? dependencyVersion(
              packageJson,
              "fastify"
            )
          : "Fastify is required by the current ShadowSpec integration."
    });

    checks.push({
      label: "pg dependency",
      status:
        dependencies.pg
          ? "PASS"
          : "FAIL",
      detail:
        dependencies.pg
          ? dependencyVersion(
              packageJson,
              "pg"
            )
          : "Run npm install pg."
    });
  }

  const configResult =
    loadConfig(cwd);

  if ("error" in configResult) {
    checks.push({
      label:
        "shadowspec.config.json",
      status: "FAIL",
      detail: configResult.error
    });

    checks.push({
      label: "schema",
      status: "FAIL",
      detail:
        "Cannot inspect schema without a valid ShadowSpec config."
    });

    checks.push({
      label: "tables",
      status: "FAIL",
      detail:
        "Cannot inspect tables without a valid ShadowSpec config."
    });

    checks.push({
      label:
        "snapshot privacy",
      status: "FAIL",
      detail:
        "Cannot inspect privacy settings without a valid ShadowSpec config."
    });
  } else {
    const config =
      configResult.config;

    checks.push({
      label:
        "shadowspec.config.json",
      status: "PASS"
    });

    if (
      typeof config.schema ===
        "string" &&
      config.schema.trim().length > 0
    ) {
      checks.push({
        label: "schema",
        status: "PASS",
        detail: config.schema
      });
    } else {
      checks.push({
        label: "schema",
        status: "FAIL",
        detail:
          "A non-empty schema name is required."
      });
    }

    if (
      Array.isArray(
        config.tables
      ) &&
      config.tables.every(
        (table) =>
          typeof table ===
            "string" &&
          table.trim().length > 0
      )
    ) {
      if (
        config.tables.length === 0
      ) {
        checks.push({
          label: "tables",
          status: "REVIEW",
          detail:
            "No application tables are configured."
        });
      } else {
        checks.push({
          label: "tables",
          status: "PASS",
          detail:
            `${config.tables.length} configured`
        });
      }
    } else {
      checks.push({
        label: "tables",
        status: "FAIL",
        detail:
          "tables must be an array of non-empty strings."
      });
    }

    const snapshotAllowedColumns =
      config.privacy
        ?.snapshotAllowedColumns;

    if (
      snapshotAllowedColumns ===
        undefined ||
      (
        typeof snapshotAllowedColumns ===
          "object" &&
        snapshotAllowedColumns !==
          null &&
        !Array.isArray(
          snapshotAllowedColumns
        )
      )
    ) {
      if (
        hasApprovedSnapshotColumns(
          snapshotAllowedColumns
        )
      ) {
        checks.push({
          label:
            "snapshot privacy",
          status: "PASS",
          detail:
            "Explicit snapshot columns are configured."
        });
      } else {
        checks.push({
          label:
            "snapshot privacy",
          status: "REVIEW",
          detail:
            "No snapshot columns are explicitly approved."
        });
      }
    } else {
      checks.push({
        label:
          "snapshot privacy",
        status: "FAIL",
        detail:
          "privacy.snapshotAllowedColumns must be an object."
      });
    }
  }

  const passed =
    checks.filter(
      (check) =>
        check.status === "PASS"
    ).length;

  const review =
    checks.filter(
      (check) =>
        check.status === "REVIEW"
    ).length;

  const failed =
    checks.filter(
      (check) =>
        check.status === "FAIL"
    ).length;

  return {
    checks,
    passed,
    review,
    failed
  };
}

function printSection(
  title: string,
  checks: DoctorCheck[]
): void {
  console.log(title);

  for (const check of checks) {
    const detail =
      check.detail
        ? ` (${check.detail})`
        : "";

    console.log(
      `  ${check.label.padEnd(28)} ${check.status}${detail}`
    );
  }
}

export function runDoctorCli(
  args: readonly string[] =
    process.argv.slice(3)
): void {
  if (args.length > 0) {
    throw new DoctorError(
      "DOCTOR_ARGUMENT_INVALID",
      `Unknown doctor argument: ${args[0]}`
    );
  }

  const result =
    runDoctor(
      process.cwd()
    );

  console.log(
    "ShadowSpec Doctor"
  );

  console.log(
    "================="
  );

  console.log("");

  printSection(
    "Project:",
    result.checks.slice(
      0,
      4
    )
  );

  console.log("");

  printSection(
    "Configuration:",
    result.checks.slice(
      4
    )
  );

  console.log("");

  console.log("Result:");

  console.log(
    `  ${result.passed} passed`
  );

  console.log(
    `  ${result.review} review`
  );

  console.log(
    `  ${result.failed} failed`
  );

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}