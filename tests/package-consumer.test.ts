import {
  execFileSync
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const fixtureDirectory = path.join(
  projectRoot,
  "tests",
  "fixtures",
  "package-consumer"
);
const typeScriptCli = path.join(
  path.dirname(require.resolve("typescript")),
  "tsc.js"
);
const npmCli = process.env.npm_execpath;
const npmCache = fs.mkdtempSync(
  path.join(
    os.tmpdir(),
    "shadowspec-package-test-"
  )
);

describe("package consumer", () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        typeScriptCli,
        "-p",
        "tsconfig.build.json"
      ],
      {
        cwd: projectRoot,
        stdio: "pipe"
      }
    );
  });

  afterAll(() => {
    fs.rmSync(npmCache, {
      recursive: true,
      force: true
    });
  });

  it("loads the built package and exposed SQL subpath", () => {
    execFileSync(
      process.execPath,
      ["consumer.cjs"],
      {
        cwd: fixtureDirectory,
        stdio: "pipe"
      }
    );
  });

  it("provides usable TypeScript declarations", () => {
    execFileSync(
      process.execPath,
      [
        typeScriptCli,
        "-p",
        path.join(
          fixtureDirectory,
          "tsconfig.json"
        )
      ],
      {
        cwd: projectRoot,
        stdio: "pipe"
      }
    );
  });

  it("packages only the public build and capture schema", () => {
    if (!npmCli) {
      throw new Error(
        "npm_execpath is required for the package smoke test."
      );
    }

    const output = execFileSync(
      process.execPath,
      [
        npmCli,
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--cache",
        npmCache
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: npmCache
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const [packResult] = JSON.parse(output) as [
      {
        files: { path: string }[];
      }
    ];

    const files = packResult.files.map(
      (file) => file.path
    );

    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/index.d.ts");
    expect(files).toContain(
      "sql/capture-schema.sql"
    );
    expect(files).toContain(
      "sql/replay-target-schema.sql"
    );
    expect(files).toContain(
      "sql/authorize-replay-target.sql.example"
    );
    expect(files).not.toContain("src/server.ts");
    expect(files).not.toContain("db/schema.sql");
    expect(
      files.some((file) =>
        file.startsWith("src/")
      )
    ).toBe(false);
  }, 15_000);
});
