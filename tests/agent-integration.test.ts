import Fastify from "fastify";
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

function createPool(
  snapshotRows: Record<string, unknown>[] = [],
  failures: {
    snapshot?: Error;
    recorder?: Error;
  } = {}
) {
  const clientQuery = vi.fn(
    async (query: string, parameters?: unknown[]) => {
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

      const columns = Object.keys(snapshotRows[0] ?? { id: 1 })
        .sort();
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
  const connect = vi.fn(async () => client);
  const end = vi.fn();
  const pool = {
    query,
    connect,
    end
  } as unknown as Pool;

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
    tables: ["books"]
  });

  app.route({
    method,
    url: "/books/7",
    handler: async (_request, reply) => {
      mutations++;

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
        : { payload: content.requestBody })
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

  registerShadowSpec(app, options);

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
    delete process.env.SHADOWSPEC_REPLAY_TARGET;
    delete process.env.SHADOWSPEC_PROJECT_ID;
    delete process.env.SHADOWSPEC_REPLAY_DATABASE_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN;
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
      tables: ["books"]
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

    const database = createPool([
      { id: 7, title: "Dune" }
    ]);

    const response = await injectCapturedRequest({
      applicationPool: database.pool,
      enabled: true,
      tables: ["books"],
      schema: "catalog",
      snapshotStatementTimeoutMs: 1200
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
        errorCode: "SNAPSHOT_READ_FAILED"
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
});
