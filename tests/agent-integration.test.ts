import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Pool,
  PoolClient
} from "pg";
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import * as publicApi from "../src/index";
import {
  registerShadowSpec,
  registerShadowSpecReplayTarget,
  type ShadowSpecReplayTargetOptions,
  type ShadowSpecOptions
} from "../src/index";

const snapshotColumns = new WeakMap<object, string[]>();

function createPool(
  snapshotRows: Record<string, unknown>[] = [],
  failures: {
    snapshot?: Error;
    recorder?: Error;
    recorderHang?: "connect" | "begin" | "insert" | "commit";
  } = {}
) {
  const columns = Object.keys(snapshotRows[0] ?? { id: 1 }).sort();
  const clientQuery = vi.fn(
    async (query: string, parameters?: unknown[]) => {
      if (
        (failures.recorderHang === "begin" && query === "BEGIN") ||
        (failures.recorderHang === "insert" &&
          query.includes("INSERT INTO api_requests")) ||
        (failures.recorderHang === "commit" && query === "COMMIT")
      ) {
        return new Promise(() => { });
      }
      if (
        failures.recorder &&
        query.includes("INSERT INTO api_requests")
      ) {
        throw failures.recorder;
      }

      if (
        failures.snapshot &&
        query.includes("shadowspec:snapshot-relation")
      ) {
        throw failures.snapshot;
      }

      if (query.includes("shadowspec:snapshot-relation")) {
        return {
          rows: [{
            oid: "41",
            relkind: "r",
            relpersistence: "p",
            has_inheritance: false
          }]
        };
      }

      if (query.includes("shadowspec:snapshot-columns")) {
        return {
          rows: columns.map((attname) => ({ attname }))
        };
      }

      if (query.includes("shadowspec:snapshot-primary-key")) {
        const key = columns.find((column) =>
          column === "id" || column.endsWith("Id") || column.endsWith("_id")
        ) ?? columns[0];
        return { rows: [{ attname: key, position: 1 }] };
      }

      if (query.startsWith("SELECT ")) {
        return { rows: snapshotRows };
      }

      return {
        rows: query.includes("RETURNING id")
          ? [{ id: 41 }]
          : []
      };
    }
  );
  const release = vi.fn();
  const client = {
    query: clientQuery,
    release
  } as unknown as PoolClient;
  const query = vi.fn(async () => {
    return { rows: [] };
  });
  const connect = vi.fn(() =>
    failures.recorderHang === "connect"
      ? new Promise<PoolClient>(() => { })
      : Promise.resolve(client)
  );
  const end = vi.fn();
  const pool = {
    query,
    connect,
    end
  } as unknown as Pool;
  snapshotColumns.set(pool, columns);

  return {
    pool,
    query,
    connect,
    end,
    clientQuery,
    release
  };
}

function createLogger() {
  const error = vi.fn();
  const logger: any = {
    level: "info",
    fatal: vi.fn(),
    error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => logger)
  };

  return { logger, error };
}

async function injectMutation(
  method: "POST" | "PATCH" | "DELETE",
  application: ReturnType<typeof createPool>,
  capture: ReturnType<typeof createPool>,
  loggerInstance?: any,
  content?: {
    requestBody?: unknown;
    responseBody?: unknown;
    responseHeaders?: Record<string, string>;
    requestHeaders?: Record<string, string>;
    privacy?: ShadowSpecOptions["privacy"];
  }
) {
  const app = Fastify({
    ...(loggerInstance === undefined
      ? {}
      : { loggerInstance })
  });
  let mutations = 0;

  registerShadowSpec(app, {
    applicationPool: application.pool,
    capturePool: capture.pool,
    enabled: true,
    tables: ["books"],
    privacy: {
      snapshotAllowedColumns: {
        books: snapshotColumns.get(application.pool) ?? ["id"]
      },
      ...content?.privacy
    }
  });

  app.route({
    method,
    url: "/books/7",
    handler: async (_request, reply) => {
      mutations++;

      for (const [name, value] of Object.entries(
        content?.responseHeaders ?? {}
      )) {
        reply.header(name, value);
      }

      return reply.code(
        method === "POST" ? 201 : 200
      ).send(
        content?.responseBody ?? {
          ok: true,
          method
        }
      );
    }
  });

  try {
    const response = await app.inject({
      method,
      url: "/books/7",
      ...(content?.requestBody === undefined
        ? {}
        : { payload: content.requestBody }),
      ...(content?.requestHeaders === undefined
        ? {}
        : { headers: content.requestHeaders })
    });

    return { response, mutations };
  } finally {
    await app.close();
  }
}

async function injectCapturedRequest(
  options: ShadowSpecOptions
) {
  const app = Fastify();

  const tables = options.tables ?? (
    process.env.SHADOWSPEC_TABLES ?? ""
  ).split(",").map((table) => table.trim()).filter(Boolean);
  registerShadowSpec(app, {
    ...options,
    privacy: {
      snapshotAllowedColumns: Object.fromEntries(
        tables.map((table) => [
          table,
          snapshotColumns.get(options.applicationPool) ?? ["id"]
        ])
      ),
      ...options.privacy
    }
  });

  app.get(
    "/books/:id",
    async (request) => ({
      bookId: (
        request.params as { id: string }
      ).id,
      status: "available"
    })
  );

  try {
    return await app.inject({
      method: "GET",
      url: "/books/7"
    });
  } finally {
    await app.close();
  }
}

describe("public Fastify integration", () => {
  afterEach(() => {
    delete process.env.SHADOWSPEC_CAPTURE;
    delete process.env.SHADOWSPEC_TABLES;
    delete process.env.SHADOWSPEC_SCHEMA;
    delete process.env.SHADOWSPEC_SNAPSHOT_STATEMENT_TIMEOUT_MS;
    delete process.env.SHADOWSPEC_SNAPSHOT_TIMEOUT_MS;
    delete process.env.SHADOWSPEC_RECORDER_TIMEOUT_MS;
    delete process.env.SHADOWSPEC_REPLAY_TARGET;
    delete process.env.SHADOWSPEC_PROJECT_ID;
    delete process.env.SHADOWSPEC_REPLAY_DATABASE_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exports only the public registration function at runtime", () => {
    expect(Object.keys(publicApi)).toEqual([
      "registerShadowSpec",
      "registerShadowSpecReplayTarget"
    ]);
  });

  it("keeps capture and replay-target options independently usable", () => {
    const database = createPool();
    const captureOptions: ShadowSpecOptions = {
      applicationPool: database.pool,
      enabled: false
    };
    const targetOptions:
      ShadowSpecReplayTargetOptions = {
      enabled: false
    };
    const app = Fastify();

    registerShadowSpec(app, captureOptions);
    registerShadowSpecReplayTarget(
      app,
      targetOptions
    );

    expect(
      app.hasRoute({
        method: "POST",
        url: "/__shadowspec/replay-target"
      })
    ).toBe(false);
  });

  it("does not capture replay-target handshake traffic", async () => {
    const database = createPool();
    const app = Fastify();
    registerShadowSpec(app, {
      applicationPool: database.pool,
      enabled: true,
      tables: ["books"],
      privacy: {
        snapshotAllowedColumns: { books: ["id"] }
      }
    });
    registerShadowSpecReplayTarget(app, {
      enabled: true,
      projectId:
        "11111111-1111-4111-8111-111111111111",
      replayDatabaseId:
        "22222222-2222-4222-8222-222222222222",
      replayTargetId:
        "33333333-3333-4333-8333-333333333333",
      token:
        "target-token-0123456789-abcdefghij"
    });

    const response = await app.inject({
      method: "POST",
      url: "/__shadowspec/replay-target",
      payload: {
        protocolVersion: 1,
        nonce:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets explicit disabled state override the environment", async () => {
    process.env.SHADOWSPEC_CAPTURE = "true";

    const database = createPool();
    const app = Fastify();

    registerShadowSpec(app, {
      applicationPool: database.pool,
      enabled: false
    });

    expect(
      app.hasRequestDecorator(
        "shadowSpecSnapshot"
      )
    ).toBe(false);

    app.get("/", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.end).not.toHaveBeenCalled();
  });

  it("lets explicit enabled state and tables override the environment", async () => {
    process.env.SHADOWSPEC_CAPTURE = "false";
    process.env.SHADOWSPEC_TABLES = "orders";
    process.env.SHADOWSPEC_SCHEMA = "ignored";
    process.env.SHADOWSPEC_SNAPSHOT_STATEMENT_TIMEOUT_MS = "9000";
    process.env.SHADOWSPEC_SNAPSHOT_TIMEOUT_MS = "0";
    process.env.SHADOWSPEC_RECORDER_TIMEOUT_MS = "0";

    const database = createPool([
      { id: 7, title: "Dune" }
    ]);

    const response = await injectCapturedRequest({
      applicationPool: database.pool,
      enabled: true,
      tables: ["books"],
      schema: "catalog",
      snapshotStatementTimeoutMs: 1200,
      snapshotTimeoutMs: 5000,
      recorderTimeoutMs: 5000
    });

    expect(response.statusCode).toBe(200);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('FROM ONLY "catalog"."books"')
    )).toBe(true);
    expect(database.clientQuery).toHaveBeenCalledWith(
      "SET LOCAL statement_timeout = '1200ms'"
    );
    expect(database.connect).toHaveBeenCalledTimes(2);
  });

  it("preserves environment fallback behavior", async () => {
    process.env.SHADOWSPEC_CAPTURE = "true";
    process.env.SHADOWSPEC_TABLES =
      "libraries, books";
    process.env.SHADOWSPEC_SCHEMA = "catalog";
    process.env.SHADOWSPEC_SNAPSHOT_STATEMENT_TIMEOUT_MS = "2400";

    const database = createPool();

    await injectCapturedRequest({
      applicationPool: database.pool
    });

    const reads = database.clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.startsWith("SELECT "));
    expect(reads[0]).toContain('FROM ONLY "catalog"."books"');
    expect(reads[1]).toContain('FROM ONLY "catalog"."libraries"');
    expect(database.clientQuery).toHaveBeenCalledWith(
      "SET LOCAL statement_timeout = '2400ms'"
    );
    expect(database.connect).toHaveBeenCalledTimes(2);
  });

  it("loads capture settings from shadowspec.config.json when configFile is enabled", async () => {
    const originalCwd =
      process.cwd();

    const cwd =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "shadowspec-runtime-config-"
        )
      );

    try {
      fs.writeFileSync(
        path.join(
          cwd,
          "shadowspec.config.json"
        ),
        JSON.stringify({
          schema: "catalog",
          tables: [
            "books"
          ],
          capture: {
            enabled: true
          },
          privacy: {
            snapshotAllowedColumns: {
              books: [
                "id",
                "title"
              ]
            }
          }
        })
      );

      vi.spyOn(
        process,
        "cwd"
      ).mockReturnValue(cwd);

      const database =
        createPool([
          {
            id: 7,
            title: "Dune"
          }
        ]);

      const app =
        Fastify();

      registerShadowSpec(
        app,
        {
          applicationPool:
            database.pool,
          configFile: true
        }
      );

      app.get(
        "/books/:id",
        async () => ({
          ok: true
        })
      );

      const response =
        await app.inject({
          method: "GET",
          url: "/books/7"
        });

      expect(
        response.statusCode
      ).toBe(200);

      expect(
        database.clientQuery.mock.calls.some(
          ([sql]) =>
            String(sql).includes(
              'FROM ONLY "catalog"."books"'
            )
        )
      ).toBe(true);

      expect(
        database.connect
      ).toHaveBeenCalledTimes(2);

      await app.close();
    } finally {
      vi.restoreAllMocks();

      process.chdir(
        originalCwd
      );

      fs.rmSync(
        cwd,
        {
          recursive: true,
          force: true
        }
      );
    }
  });

  it("lets explicit runtime options override config file values", async () => {
    const originalCwd =
      process.cwd();

    const cwd =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "shadowspec-runtime-config-"
        )
      );

    try {
      fs.writeFileSync(
        path.join(
          cwd,
          "shadowspec.config.json"
        ),
        JSON.stringify({
          schema: "ignored",
          tables: [
            "orders"
          ],
          capture: {
            enabled: false
          },
          privacy: {
            snapshotAllowedColumns: {
              orders: [
                "id",
                "title"
              ]
            }
          }
        })
      );

      vi.spyOn(
        process,
        "cwd"
      ).mockReturnValue(cwd);

      const database =
        createPool([
          {
            id: 7,
            title: "Dune"
          }
        ]);

      const app =
        Fastify();

      registerShadowSpec(
        app,
        {
          applicationPool:
            database.pool,
          configFile: true,

          enabled: true,

          tables: [
            "books"
          ],

          schema:
            "catalog",

          privacy: {
            snapshotAllowedColumns: {
              books: [
                "id",
                "title"
              ]
            }
          }
        }
      );

      app.get(
        "/books/:id",
        async () => ({
          ok: true
        })
      );

      const response =
        await app.inject({
          method: "GET",
          url: "/books/7"
        });

      expect(
        response.statusCode
      ).toBe(200);

      expect(
        database.clientQuery.mock.calls.some(
          ([sql]) =>
            String(sql).includes(
              'FROM ONLY "catalog"."books"'
            )
        )
      ).toBe(true);

      expect(
        database.clientQuery.mock.calls.some(
          ([sql]) =>
            String(sql).includes(
              '"ignored"."orders"'
            )
        )
      ).toBe(false);

      await app.close();
    } finally {
      vi.restoreAllMocks();

      process.chdir(
        originalCwd
      );

      fs.rmSync(
        cwd,
        {
          recursive: true,
          force: true
        }
      );
    }
  });

  it("lets config file values override environment fallbacks", async () => {
    process.env.SHADOWSPEC_CAPTURE =
      "false";

    process.env.SHADOWSPEC_TABLES =
      "orders";

    process.env.SHADOWSPEC_SCHEMA =
      "environment_schema";

    const originalCwd =
      process.cwd();

    const cwd =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "shadowspec-runtime-config-"
        )
      );

    try {
      fs.writeFileSync(
        path.join(
          cwd,
          "shadowspec.config.json"
        ),
        JSON.stringify({
          schema: "catalog",
          tables: [
            "books"
          ],
          capture: {
            enabled: true
          },
          privacy: {
            snapshotAllowedColumns: {
              books: [
                "id",
                "title"
              ]
            }
          }
        })
      );

      vi.spyOn(
        process,
        "cwd"
      ).mockReturnValue(cwd);

      const database =
        createPool([
          {
            id: 7,
            title: "Dune"
          }
        ]);

      const app =
        Fastify();

      registerShadowSpec(
        app,
        {
          applicationPool:
            database.pool,
          configFile: true
        }
      );

      app.get(
        "/books/:id",
        async () => ({
          ok: true
        })
      );

      const response =
        await app.inject({
          method: "GET",
          url: "/books/7"
        });

      expect(
        response.statusCode
      ).toBe(200);

      expect(
        database.clientQuery.mock.calls.some(
          ([sql]) =>
            String(sql).includes(
              'FROM ONLY "catalog"."books"'
            )
        )
      ).toBe(true);

      expect(
        database.clientQuery.mock.calls.some(
          ([sql]) =>
            String(sql).includes(
              "environment_schema"
            )
        )
      ).toBe(false);

      await app.close();
    } finally {
      vi.restoreAllMocks();

      process.chdir(
        originalCwd
      );

      fs.rmSync(
        cwd,
        {
          recursive: true,
          force: true
        }
      );
    }
  });

  it("disables capture safely when configFile is enabled but config is missing", async () => {
    const originalCwd =
      process.cwd();

    const cwd =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "shadowspec-runtime-config-"
        )
      );

    const database =
      createPool([
        {
          id: 7,
          title: "Dune"
        }
      ]);

    const logger =
      createLogger();

    const app =
      Fastify({
        loggerInstance:
          logger.logger
      });

    try {
      vi.spyOn(
        process,
        "cwd"
      ).mockReturnValue(cwd);

      registerShadowSpec(
        app,
        {
          applicationPool:
            database.pool,
          configFile: true
        }
      );

      app.get(
        "/books/7",
        async () => ({
          ok: true
        })
      );

      const response =
        await app.inject({
          method: "GET",
          url: "/books/7"
        });

      expect(
        response.statusCode
      ).toBe(200);

      expect(
        app.hasRequestDecorator(
          "shadowSpecSnapshot"
        )
      ).toBe(false);

      expect(
        database.connect
      ).not.toHaveBeenCalled();

      expect(
        logger.error
      ).toHaveBeenCalledWith(
        {
          errorName:
            "ConfigError",
          errorCode:
            "CONFIG_NOT_FOUND"
        },
        "ShadowSpec capture disabled because its config file could not be loaded."
      );
    } finally {
      await app.close();

      vi.restoreAllMocks();

      process.chdir(
        originalCwd
      );

      fs.rmSync(
        cwd,
        {
          recursive: true,
          force: true
        }
      );
    }
  });

  it("uses the environment snapshot deadline and fails open", async () => {
    vi.useFakeTimers();
    process.env.SHADOWSPEC_CAPTURE = "true";
    process.env.SHADOWSPEC_TABLES = "books";
    process.env.SHADOWSPEC_SNAPSHOT_TIMEOUT_MS = "10";
    const connect = vi.fn(() => new Promise<PoolClient>(() => { }));
    const logger = createLogger();
    const app = Fastify({ loggerInstance: logger.logger });
    let handled = 0;

    registerShadowSpec(app, {
      applicationPool: { connect } as unknown as Pool,
      privacy: {
        snapshotAllowedColumns: { books: ["id"] }
      }
    });
    app.post("/books", async (_request, reply) => {
      handled++;
      return reply.code(201).send({ ok: true });
    });

    const responsePromise = app.inject({ method: "POST", url: "/books" });
    await vi.advanceTimersByTimeAsync(10);
    const response = await responsePromise;
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(handled).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorName: "SnapshotCaptureError",
        errorCode: "SNAPSHOT_TIMEOUT",
        errorStage: "snapshot-connect"
      },
      "ShadowSpec snapshot capture failed; request will not be recorded."
    );
    vi.useRealTimers();
    await app.close();
  });

  it("uses one pool for snapshots and capture writes without closing it", async () => {
    const database = createPool([
      { id: 7, title: "Dune" }
    ]);

    await injectCapturedRequest({
      applicationPool: database.pool,
      enabled: true,
      tables: ["books"]
    });

    expect(database.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('FROM ONLY "public"."books"')
    )).toBe(true);
    expect(database.connect).toHaveBeenCalledTimes(2);
    expect(database.clientQuery).toHaveBeenCalledWith("BEGIN");
    expect(database.clientQuery).toHaveBeenCalledWith("COMMIT");
    const recordedRequest = database.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO api_requests")
    );
    expect(recordedRequest?.[1]?.[1]).toBe("/books/7");
    expect(recordedRequest?.[1]?.[2]).toBe(JSON.stringify({ id: "7" }));
    expect(database.release).toHaveBeenCalledTimes(2);
    expect(database.end).not.toHaveBeenCalled();
  });

  it("routes snapshots and capture writes to separate pools without closing either", async () => {
    const application = createPool([
      { id: 7, title: "Dune" }
    ]);
    const capture = createPool();

    await injectCapturedRequest({
      applicationPool: application.pool,
      capturePool: capture.pool,
      enabled: true,
      tables: ["books"]
    });

    expect(application.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('FROM ONLY "public"."books"')
    )).toBe(true);
    expect(application.connect).toHaveBeenCalledTimes(1);
    expect(capture.query).not.toHaveBeenCalled();
    expect(capture.connect).toHaveBeenCalledTimes(1);
    expect(capture.clientQuery).toHaveBeenCalledWith("BEGIN");
    expect(capture.clientQuery).toHaveBeenCalledWith("COMMIT");
    expect(application.end).not.toHaveBeenCalled();
    expect(capture.end).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", 201],
    ["PATCH", 200],
    ["DELETE", 200]
  ] as const)(
    "fails open when snapshot capture fails before a %s mutation",
    async (method, expectedStatus) => {
      const application = createPool([], {
        snapshot: new Error("snapshot failed")
      });
      const capture = createPool();

      const { response, mutations } =
        await injectMutation(
          method,
          application,
          capture
        );

      expect(mutations).toBe(1);
      expect(response.statusCode).toBe(
        expectedStatus
      );
      expect(response.json()).toEqual({
        ok: true,
        method
      });
      expect(capture.connect).not.toHaveBeenCalled();
      expect(application.end).not.toHaveBeenCalled();
      expect(capture.end).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["connect", "recorder-connect"],
    ["insert", "recorder-insert"],
    ["commit", "recorder-commit"]
  ] as const)(
    "preserves the application response when recorder %s hangs",
    async (recorderHang, errorStage) => {
      vi.useFakeTimers();
      process.env.SHADOWSPEC_RECORDER_TIMEOUT_MS = "10";
      const application = createPool([{ id: 7, title: "Dune" }]);
      const capture = createPool([], { recorderHang });
      const logger = createLogger();

      const request = injectMutation(
        "POST",
        application,
        capture,
        logger.logger,
        {
          requestBody: { title: "Dune" },
          responseBody: { ok: true, created: 41 }
        }
      );
      await vi.advanceTimersByTimeAsync(10);
      const { response, mutations } = await request;

      expect(mutations).toBe(1);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ ok: true, created: 41 });
      expect(logger.error).toHaveBeenCalledWith(
        {
          errorName: "CaptureRecordError",
          errorCode: "CAPTURE_RECORD_TIMEOUT",
          errorStage
        },
        "ShadowSpec recorder write failed; response will be sent unchanged."
      );
    }
  );

  it.each([
    ["POST", 201],
    ["PATCH", 200],
    ["DELETE", 200]
  ] as const)(
    "preserves a successful %s mutation response when recording fails",
    async (method, expectedStatus) => {
      const application = createPool([
        { id: 7, title: "Dune" }
      ]);
      const capture = createPool([], {
        recorder: new Error("recorder failed")
      });

      const { response, mutations } =
        await injectMutation(
          method,
          application,
          capture
        );

      expect(mutations).toBe(1);
      expect(response.statusCode).toBe(
        expectedStatus
      );
      expect(response.json()).toEqual({
        ok: true,
        method
      });
      expect(capture.connect).toHaveBeenCalledTimes(1);
      expect(capture.clientQuery).toHaveBeenCalledWith(
        "ROLLBACK"
      );
      expect(application.end).not.toHaveBeenCalled();
      expect(capture.end).not.toHaveBeenCalled();
    }
  );

  it("logs capture failures without request, response, snapshot, or error-message data", async () => {
    const snapshotLogger = createLogger();
    const snapshotApplication = createPool([], {
      snapshot: new Error("snapshot-error-secret")
    });
    const snapshotCapture = createPool();

    await injectMutation(
      "POST",
      snapshotApplication,
      snapshotCapture,
      snapshotLogger.logger
    );

    const recorderLogger = createLogger();
    const recorderApplication = createPool([
      { id: 7, privateValue: "snapshot-secret" }
    ]);
    const recorderCapture = createPool([], {
      recorder: new Error("recorder-error-secret")
    });

    await injectMutation(
      "POST",
      recorderApplication,
      recorderCapture,
      recorderLogger.logger,
      {
        requestBody: {
          privateValue: "request-secret"
        },
        responseBody: {
          privateValue: "response-secret"
        }
      }
    );

    expect(snapshotLogger.error).toHaveBeenCalledWith(
      {
        errorName: "SnapshotCaptureError",
        errorCode: "SNAPSHOT_READ_FAILED",
        errorStage: "snapshot-read"
      },
      "ShadowSpec snapshot capture failed; request will not be recorded."
    );
    expect(recorderLogger.error).toHaveBeenCalledWith(
      { errorName: "Error" },
      "ShadowSpec recorder write failed; response will be sent unchanged."
    );

    const logged = JSON.stringify([
      snapshotLogger.error.mock.calls,
      recorderLogger.error.mock.calls
    ]);

    expect(logged).not.toContain("snapshot-secret");
    expect(logged).not.toContain("request-secret");
    expect(logged).not.toContain("response-secret");
    expect(logged).not.toContain(
      "snapshot-error-secret"
    );
    expect(logged).not.toContain(
      "recorder-error-secret"
    );
  });

  it.each([
    "Authorization",
    "aUtHoRiZaTiOn",
    "Cookie"
  ])("rejects the %s credential header before snapshot capture", async (name) => {
    const application = createPool([{ id: 7 }]);
    const capture = createPool();
    const logger = createLogger();
    const secret = "header-value-must-not-be-logged";

    const { response, mutations } = await injectMutation(
      "POST",
      application,
      capture,
      logger.logger,
      { requestHeaders: { [name]: secret } }
    );

    expect(mutations).toBe(1);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, method: "POST" });
    expect(application.connect).not.toHaveBeenCalled();
    expect(capture.connect).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "CAPTURE_SECRET_REPLAY_REQUIRED",
        errorLocation: "header",
        errorHeader: name.toLowerCase()
      }),
      "ShadowSpec request capture rejected by its privacy policy."
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  it("rejects a configured header without logging its value", async () => {
    const application = createPool([{ id: 7 }]);
    const capture = createPool();
    const logger = createLogger();
    const secret = "configured-header-secret";

    await injectMutation("POST", application, capture, logger.logger, {
      requestHeaders: { "x-api-key": secret },
      privacy: { forbiddenHeaders: ["X-API-Key"] }
    });

    expect(application.connect).not.toHaveBeenCalled();
    expect(capture.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  it("rejects an exact request pointer before snapshot and preserves the mutation", async () => {
    const application = createPool([{ id: 7 }]);
    const capture = createPool();

    const { response, mutations } = await injectMutation(
      "PATCH",
      application,
      capture,
      undefined,
      {
        requestBody: { credentials: { password: "private" } },
        privacy: {
          forbiddenRequestPointers: ["/body/credentials/password"]
        }
      }
    );

    expect(mutations).toBe(1);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, method: "PATCH" });
    expect(application.connect).not.toHaveBeenCalled();
    expect(capture.connect).not.toHaveBeenCalled();
  });

  it("rejects an exact response pointer before recording and preserves the response", async () => {
    const application = createPool([{ id: 7 }]);
    const capture = createPool();
    const logger = createLogger();
    const secret = "response-value-must-not-be-logged";

    const { response, mutations } = await injectMutation(
      "POST",
      application,
      capture,
      logger.logger,
      {
        responseBody: { data: { token: secret }, ok: true },
        responseHeaders: { "x-application-result": "unchanged" },
        privacy: {
          forbiddenResponsePointers: ["/body/data/token"]
        }
      }
    );

    expect(mutations).toBe(1);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: { token: secret },
      ok: true
    });
    expect(response.headers["x-application-result"]).toBe("unchanged");
    expect(application.connect).toHaveBeenCalledTimes(1);
    expect(capture.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  it("disables capture safely and logs once for malformed privacy configuration", async () => {
    const database = createPool([{ id: 7 }]);
    const logger = createLogger();
    const app = Fastify({ loggerInstance: logger.logger });

    registerShadowSpec(app, {
      applicationPool: database.pool,
      enabled: true,
      tables: ["books"],
      privacy: {
        snapshotAllowedColumns: { books: ["id"] },
        forbiddenRequestPointers: ["/body/bad~escape"]
      }
    });
    app.post("/books", async (_request, reply) =>
      reply.code(201).send({ ok: true })
    );

    const response = await app.inject({
      method: "POST",
      url: "/books",
      payload: { value: "raw-material" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(database.connect).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorName: "CapturePrivacyError",
        errorCode: "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
      },
      "ShadowSpec capture disabled because its privacy configuration is invalid."
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("raw-material");
    await app.close();
  });

  it("captures normally with only a ShadowSpec correlation header", async () => {
    const application = createPool([{ id: 7 }]);
    const capture = createPool();

    const { response } = await injectMutation(
      "POST",
      application,
      capture,
      undefined,
      {
        requestHeaders: {
          "x-shadowspec-session-id": "dedicated-capture-session"
        }
      }
    );

    expect(response.statusCode).toBe(201);
    expect(application.connect).toHaveBeenCalledTimes(1);
    expect(capture.connect).toHaveBeenCalledTimes(1);
    const insert = capture.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO api_requests")
    );
    expect(insert?.[1]?.[7]).toBe("dedicated-capture-session");
  });

  it("fails open without recording or logging row values on snapshot authorization failure", async () => {
    const sentinel = "snapshot-value-must-not-be-read-or-logged";
    const application = createPool([{
      id: 7,
      title: "Dune",
      unauthorized: sentinel
    }]);
    const capture = createPool();
    const logger = createLogger();

    const { response, mutations } = await injectMutation(
      "POST",
      application,
      capture,
      logger.logger,
      {
        privacy: {
          snapshotAllowedColumns: {
            books: ["id", "title"]
          }
        }
      }
    );

    expect(mutations).toBe(1);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, method: "POST" });
    expect(application.clientQuery.mock.calls.some(([sql]) =>
      String(sql).startsWith("SELECT ")
    )).toBe(false);
    expect(capture.connect).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorName: "CapturePrivacyError",
        errorCode: "CAPTURE_SNAPSHOT_COLUMN_FORBIDDEN",
        errorTable: "books",
        errorColumn: "unauthorized"
      },
      "ShadowSpec snapshot capture failed; request will not be recorded."
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(sentinel);
  });
});
