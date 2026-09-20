import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";
import {
  ConfigError,
  loadConfig,
  validateConfig
} from "../src/config";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "shadowspec-config-"
    )
  );

  tempDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(
      dir,
      {
        recursive: true,
        force: true
      }
    );
  }
});

describe("ShadowSpec config", () => {
  it("validates the canonical config", () => {
    const config =
      validateConfig({
        schema: "public",
        tables: [
          "orders"
        ],
        capture: {
          enabled: true
        },
        privacy: {
          snapshotAllowedColumns: {
            orders: [
              "id",
              "status"
            ]
          }
        }
      });

    expect(config).toEqual({
      schema: "public",
      tables: [
        "orders"
      ],
      capture: {
        enabled: true
      },
      privacy: {
        snapshotAllowedColumns: {
          orders: [
            "id",
            "status"
          ]
        }
      }
    });
  });

  it("allows empty tables and empty privacy mappings", () => {
    const config =
      validateConfig({
        schema: "public",
        tables: [],
        capture: {
          enabled: true
        },
        privacy: {
          snapshotAllowedColumns: {}
        }
      });

    expect(config.tables).toEqual([]);

    expect(
      config.privacy
        .snapshotAllowedColumns
    ).toEqual({});
  });

  it("rejects an invalid schema", () => {
    expect(
      () =>
        validateConfig({
          schema: "",
          tables: [],
          capture: {
            enabled: true
          },
          privacy: {
            snapshotAllowedColumns: {}
          }
        })
    ).toThrowError(
      expect.objectContaining({
        code:
          "CONFIG_INVALID_SCHEMA"
      })
    );
  });

  it("rejects invalid tables", () => {
    expect(
      () =>
        validateConfig({
          schema: "public",
          tables: [
            "orders",
            ""
          ],
          capture: {
            enabled: true
          },
          privacy: {
            snapshotAllowedColumns: {}
          }
        })
    ).toThrowError(
      expect.objectContaining({
        code:
          "CONFIG_INVALID_TABLES"
      })
    );
  });

  it("rejects invalid capture configuration", () => {
    expect(
      () =>
        validateConfig({
          schema: "public",
          tables: [],
          capture: {
            enabled: "yes"
          },
          privacy: {
            snapshotAllowedColumns: {}
          }
        })
    ).toThrowError(
      expect.objectContaining({
        code:
          "CONFIG_INVALID_CAPTURE"
      })
    );
  });

  it("rejects invalid snapshot privacy configuration", () => {
    expect(
      () =>
        validateConfig({
          schema: "public",
          tables: [],
          capture: {
            enabled: true
          },
          privacy: {
            snapshotAllowedColumns: {
              orders: [
                ""
              ]
            }
          }
        })
    ).toThrowError(
      expect.objectContaining({
        code:
          "CONFIG_INVALID_PRIVACY"
      })
    );
  });

  it("loads a valid config from disk", () => {
    const cwd =
      createTempDir();

    fs.writeFileSync(
      path.join(
        cwd,
        "shadowspec.config.json"
      ),
      JSON.stringify({
        schema: "app",
        tables: [
          "orders"
        ],
        capture: {
          enabled: false
        },
        privacy: {
          snapshotAllowedColumns: {
            orders: [
              "id"
            ]
          }
        }
      })
    );

    const config =
      loadConfig(cwd);

    expect(
      config.schema
    ).toBe("app");

    expect(
      config.capture.enabled
    ).toBe(false);
  });

  it("fails when the config file is missing", () => {
    const cwd =
      createTempDir();

    expect(
      () => loadConfig(cwd)
    ).toThrowError(
      expect.objectContaining({
        code:
          "CONFIG_NOT_FOUND"
      })
    );
  });

  it("fails when the config file contains invalid JSON", () => {
    const cwd =
      createTempDir();

    fs.writeFileSync(
      path.join(
        cwd,
        "shadowspec.config.json"
      ),
      "{ invalid json"
    );

    expect(
      () => loadConfig(cwd)
    ).toThrowError(
      expect.objectContaining({
        code:
          "CONFIG_INVALID_JSON"
      })
    );
  });

  it("uses ConfigError for validation failures", () => {
    try {
      validateConfig({
        schema: 123
      });
    } catch (error) {
      expect(
        error
      ).toBeInstanceOf(
        ConfigError
      );

      return;
    }

    throw new Error(
      "Expected validateConfig to fail."
    );
  });
});