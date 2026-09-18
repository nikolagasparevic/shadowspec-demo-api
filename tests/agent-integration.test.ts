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
    async (query: string) => {
      if (
        failures.recorder &&
        query.includes("INSERT INTO api_requests")
      ) {
        throw failures.recorder;
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
    if (failures.snapshot) {
      throw failures.snapshot;
    }

    return {
      rows: snapshotRows
    };
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
    vi.clearAllMocks();
  });

  it("exports only the public registration function at runtime", () => {
    expect(Object.keys(publicApi)).toEqual([
      "registerShadowSpec"
    ]);
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

    const database = createPool([
      { id: 7, title: "Dune" }
    ]);

    const response = await injectCapturedRequest({
      applicationPool: database.pool,
      enabled: true,
      tables: ["books"]
    });

    expect(response.statusCode).toBe(200);
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.query).toHaveBeenCalledWith(
      'SELECT * FROM "books"'
    );
    expect(database.connect).toHaveBeenCalledTimes(1);
  });

  it("preserves environment fallback behavior", async () => {
    process.env.SHADOWSPEC_CAPTURE = "true";
    process.env.SHADOWSPEC_TABLES =
      "libraries, books";

    const database = createPool();

    await injectCapturedRequest({
      applicationPool: database.pool
    });

    expect(database.query).toHaveBeenNthCalledWith(
      1,
      'SELECT * FROM "libraries"'
    );
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      'SELECT * FROM "books"'
    );
    expect(database.connect).toHaveBeenCalledTimes(1);
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

    expect(database.query).toHaveBeenCalledWith(
      'SELECT * FROM "books"'
    );
    expect(database.connect).toHaveBeenCalledTimes(1);
    expect(database.clientQuery).toHaveBeenNthCalledWith(
      1,
      "BEGIN"
    );
    expect(database.clientQuery).toHaveBeenNthCalledWith(
      4,
      "COMMIT"
    );
    expect(database.release).toHaveBeenCalledTimes(1);
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

    expect(application.query).toHaveBeenCalledWith(
      'SELECT * FROM "books"'
    );
    expect(application.connect).not.toHaveBeenCalled();
    expect(capture.query).not.toHaveBeenCalled();
    expect(capture.connect).toHaveBeenCalledTimes(1);
    expect(capture.clientQuery).toHaveBeenNthCalledWith(
      1,
      "BEGIN"
    );
    expect(capture.clientQuery).toHaveBeenNthCalledWith(
      4,
      "COMMIT"
    );
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
      { errorName: "Error" },
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
