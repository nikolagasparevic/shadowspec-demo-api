import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
    ShadowSpecConfig,
    validateConfig
} from "./config";
import {
    introspectSchema
} from "./init-introspection";

const CONFIG_FILE =
    "shadowspec.config.json";

type PackageJson = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

type DependencyStatus = {
    shadowspec: boolean;
    fastify: boolean;
    pg: boolean;
};

type InitOptions = {
    inspectDb?: boolean;
    schema?: string;
};

export class InitError extends Error {
    readonly name = "InitError";

    constructor(
        readonly code:
            | "INIT_NOT_NODE_PROJECT"
            | "INIT_PACKAGE_JSON_INVALID"
            | "INIT_CONFIG_EXISTS"
            | "INIT_WRITE_FAILED"
            | "INIT_ARGUMENT_INVALID"
            | "INIT_DATABASE_INSPECTION_FAILED",
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

export function defaultConfig(): ShadowSpecConfig {
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
    cwd = process.cwd(),
    options: InitOptions = {}
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

    let discoveredTables:
        Awaited<
            ReturnType<typeof introspectSchema>
        > = [];

    if (options.inspectDb) {
        const pool = new Pool({
            host:
                process.env.DB_HOST ||
                "localhost",
            port: Number(
                process.env.DB_PORT ||
                5432
            ),
            user:
                process.env.DB_USER ||
                "shadowspec",
            password:
                process.env.DB_PASSWORD ||
                "shadowspec123",
            database:
                process.env.DB_NAME ||
                "shadowspec"
        });

        try {
            discoveredTables =
                await introspectSchema(
                    pool,
                    options.schema ?? "public"
                );
        } catch {
            throw new InitError(
                "INIT_DATABASE_INSPECTION_FAILED",
                "ShadowSpec could not inspect the PostgreSQL database."
            );
        } finally {
            await pool.end();
        }
    }

    const config =
        defaultConfig();

    config.schema =
        options.schema ?? "public";

    if (options.inspectDb) {
        config.tables =
            discoveredTables.map(
                (table) => table.name
            );
    }

    const validatedConfig =
        validateConfig(config);

    try {
        fs.writeFileSync(
            configPath,
            `${JSON.stringify(
                validatedConfig,
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

    console.log(
        "ShadowSpec Init"
    );

    console.log(
        "==============="
    );

    console.log(
        `Created ${CONFIG_FILE}`
    );

    if (options.inspectDb) {
        console.log("");

        console.log(
            "Database inspection:"
        );

        if (
            discoveredTables.length === 0
        ) {
            console.log(
                `  No application tables found in schema ${options.schema ?? "public"}.`
            );
        } else {
            for (
                const table of discoveredTables
            ) {
                console.log(
                    `  ${table.name}: ${table.columns.join(", ")}`
                );
            }
        }

        console.log("");

        console.log(
            "  Tables were added to the config."
        );

        console.log(
            "  Snapshot columns were NOT automatically approved."
        );
    }

    console.log("");

    console.log(
        "Project checks:"
    );

    console.log(
        `  shadowspec: ${dependencies.shadowspec
            ? "found"
            : "missing"
        }`
    );

    console.log(
        `  fastify:    ${dependencies.fastify
            ? "found"
            : "missing"
        }`
    );

    console.log(
        `  pg:         ${dependencies.pg
            ? "found"
            : "missing"
        }`
    );

    console.log("");

    console.log(
        "Next steps:"
    );

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

    if (options.inspectDb) {
        console.log(
            `  Review ${CONFIG_FILE} and explicitly approve snapshot columns.`
        );
    } else {
        console.log(
            `  Configure tables and privacy rules in ${CONFIG_FILE}.`
        );
    }

    console.log(
        "  Apply ShadowSpec's capture schema to your PostgreSQL database."
    );

    console.log(
        "  Register ShadowSpec in your Fastify application."
    );
}

export async function runInitCli(
    args: readonly string[] =
        process.argv.slice(3)
): Promise<void> {
    let inspectDb = false;
    let schema = "public";

    for (
        let index = 0;
        index < args.length;
        index++
    ) {
        const arg = args[index];

        if (arg === "--inspect-db") {
            inspectDb = true;
            continue;
        }

        if (arg === "--schema") {
            const value =
                args[index + 1];

            if (
                !value ||
                value.startsWith("--")
            ) {
                throw new InitError(
                    "INIT_ARGUMENT_INVALID",
                    "--schema requires a schema name."
                );
            }

            schema = value;
            index++;
            continue;
        }

        throw new InitError(
            "INIT_ARGUMENT_INVALID",
            `Unknown init argument: ${arg}`
        );
    }

    await runInit(
        process.cwd(),
        {
            inspectDb,
            schema
        }
    );
}