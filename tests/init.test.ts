import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  InitError,
  defaultConfig,
  detectDependencies,
  runInit
} from "../src/init";

const tempDirectories: string[] = [];

function createTempProject(): string {
  const directory = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "shadowspec-init-"
    )
  );

  tempDirectories.push(directory);

  return directory;
}

function writePackageJson(
  directory: string,
  value: unknown
): void {
  fs.writeFileSync(
    path.join(
      directory,
      "package.json"
    ),
    `${JSON.stringify(
      value,
      null,
      2
    )}\n`,
    "utf8"
  );
}

afterEach(() => {
  vi.restoreAllMocks();

  for (
    const directory of tempDirectories.splice(0)
  ) {
    fs.rmSync(
      directory,
      {
        recursive: true,
        force: true
      }
    );
  }
});

describe("ShadowSpec init", () => {
  it("rejects a directory without package.json", async () => {
    const directory =
      createTempProject();

    await expect(
      runInit(directory)
    ).rejects.toMatchObject({
      name: "InitError",
      code: "INIT_NOT_NODE_PROJECT"
    });
  });

  it("rejects an invalid package.json", async () => {
    const directory =
      createTempProject();

    fs.writeFileSync(
      path.join(
        directory,
        "package.json"
      ),
      "{ invalid json",
      "utf8"
    );

    await expect(
      runInit(directory)
    ).rejects.toMatchObject({
      name: "InitError",
      code: "INIT_PACKAGE_JSON_INVALID"
    });
  });

  it("creates the default ShadowSpec config", async () => {
    const directory =
      createTempProject();

    writePackageJson(
      directory,
      {
        name: "example-project",
        dependencies: {
          shadowspec: "^0.1.0",
          fastify: "^5.0.0",
          pg: "^8.0.0"
        }
      }
    );

    vi.spyOn(
      console,
      "log"
    ).mockImplementation(
      () => undefined
    );

    await runInit(directory);

    const configPath =
      path.join(
        directory,
        "shadowspec.config.json"
      );

    expect(
      fs.existsSync(configPath)
    ).toBe(true);

    const config =
      JSON.parse(
        fs.readFileSync(
          configPath,
          "utf8"
        )
      );

    expect(config).toEqual(
      defaultConfig()
    );
  });

  it("detects dependencies from dependencies and devDependencies", () => {
    expect(
      detectDependencies({
        dependencies: {
          shadowspec: "^0.1.0",
          pg: "^8.0.0"
        },
        devDependencies: {
          fastify: "^5.0.0"
        }
      })
    ).toEqual({
      shadowspec: true,
      fastify: true,
      pg: true
    });
  });

  it("reports missing dependencies", () => {
    expect(
      detectDependencies({})
    ).toEqual({
      shadowspec: false,
      fastify: false,
      pg: false
    });
  });

  it("refuses to overwrite an existing config", async () => {
    const directory =
      createTempProject();

    writePackageJson(
      directory,
      {
        name: "example-project"
      }
    );

    const configPath =
      path.join(
        directory,
        "shadowspec.config.json"
      );

    const original =
      `{"custom":true}\n`;

    fs.writeFileSync(
      configPath,
      original,
      "utf8"
    );

    await expect(
      runInit(directory)
    ).rejects.toMatchObject({
      name: "InitError",
      code: "INIT_CONFIG_EXISTS"
    });

    expect(
      fs.readFileSync(
        configPath,
        "utf8"
      )
    ).toBe(original);
  });

  it("prints dependency status and next steps", async () => {
    const directory =
      createTempProject();

    writePackageJson(
      directory,
      {
        name: "example-project",
        dependencies: {
          shadowspec: "^0.1.0",
          fastify: "^5.0.0"
        }
      }
    );

    const log =
      vi.spyOn(
        console,
        "log"
      ).mockImplementation(
        () => undefined
      );

    await runInit(directory);

    const output =
      log.mock.calls
        .map(
          ([message]) =>
            String(message)
        )
        .join("\n");

    expect(output).toContain(
      "Created shadowspec.config.json"
    );

    expect(output).toContain(
      "shadowspec: found"
    );

    expect(output).toContain(
      "fastify:    found"
    );

    expect(output).toContain(
      "pg:         missing"
    );

    expect(output).toContain(
      "npm install pg"
    );
  });

  it("uses InitError for init failures", () => {
    const error =
      new InitError(
        "INIT_WRITE_FAILED",
        "example"
      );

    expect(error).toBeInstanceOf(
      Error
    );

    expect(error.name).toBe(
      "InitError"
    );

    expect(error.code).toBe(
      "INIT_WRITE_FAILED"
    );
  });
});