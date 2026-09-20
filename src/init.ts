import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = "shadowspec.config.json";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type DependencyStatus = {
  shadowspec: boolean;
  fastify: boolean;
  pg: boolean;
};

export class InitError extends Error {
  readonly name = "InitError";

  constructor(
    readonly code:
      | "INIT_NOT_NODE_PROJECT"
      | "INIT_PACKAGE_JSON_INVALID"
      | "INIT_CONFIG_EXISTS"
      | "INIT_WRITE_FAILED",
    message: string
  ) {
    super(message);
  }
}

function dependencyExists(
  packageJson: PackageJson,
  name: string
): boolean {
  return Boolean(
    packageJson.dependencies?.[name] ||
      packageJson.devDependencies?.[name]
  );
}

export function detectDependencies(
  packageJson: PackageJson
): DependencyStatus {
  return {
    shadowspec: dependencyExists(
      packageJson,
      "shadowspec"
    ),
    fastify: dependencyExists(
      packageJson,
      "fastify"
    ),
    pg: dependencyExists(
      packageJson,
      "pg"
    )
  };
}

export function defaultConfig() {
  return {
    schema: "public",
    tables: [],
    capture: {
      enabled: true
    },
    privacy: {
      snapshotAllowedColumns: {}
    }
  };
}

export async function runInit(
  cwd = process.cwd()
): Promise<void> {
  const packagePath = path.join(
    cwd,
    "package.json"
  );

  if (!fs.existsSync(packagePath)) {
    throw new InitError(
      "INIT_NOT_NODE_PROJECT",
      "ShadowSpec init must be run from a Node.js project containing package.json."
    );
  }

  let packageJson: PackageJson;

  try {
    packageJson = JSON.parse(
      fs.readFileSync(
        packagePath,
        "utf8"
      )
    ) as PackageJson;
  } catch {
    throw new InitError(
      "INIT_PACKAGE_JSON_INVALID",
      "ShadowSpec could not read a valid package.json."
    );
  }

  const configPath = path.join(
    cwd,
    CONFIG_FILE
  );

  if (fs.existsSync(configPath)) {
    throw new InitError(
      "INIT_CONFIG_EXISTS",
      `${CONFIG_FILE} already exists. ShadowSpec will not overwrite it.`
    );
  }

  const dependencies =
    detectDependencies(packageJson);

  try {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        defaultConfig(),
        null,
        2
      )}\n`,
      {
        encoding: "utf8",
        flag: "wx"
      }
    );
  } catch {
    throw new InitError(
      "INIT_WRITE_FAILED",
      `ShadowSpec could not create ${CONFIG_FILE}.`
    );
  }

  console.log("ShadowSpec Init");
  console.log("===============");
  console.log(
    `Created ${CONFIG_FILE}`
  );
  console.log("");

  console.log("Project checks:");
  console.log(
    `  shadowspec: ${
      dependencies.shadowspec
        ? "found"
        : "missing"
    }`
  );
  console.log(
    `  fastify:    ${
      dependencies.fastify
        ? "found"
        : "missing"
    }`
  );
  console.log(
    `  pg:         ${
      dependencies.pg
        ? "found"
        : "missing"
    }`
  );

  console.log("");
  console.log("Next steps:");

  if (!dependencies.shadowspec) {
    console.log(
      "  npm install shadowspec"
    );
  }

  if (!dependencies.fastify) {
    console.log(
      "  Install Fastify before using the current ShadowSpec integration."
    );
  }

  if (!dependencies.pg) {
    console.log(
      "  npm install pg"
    );
  }

  console.log(
    `  Configure tables and privacy rules in ${CONFIG_FILE}.`
  );
  console.log(
    "  Apply ShadowSpec's capture schema to your PostgreSQL database."
  );
  console.log(
    "  Register ShadowSpec in your Fastify application."
  );
}

export async function runInitCli(): Promise<void> {
  await runInit();
}