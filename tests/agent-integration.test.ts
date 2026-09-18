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
  snapshotRows: Record<string, unknown>[] = []
) {
  const clientQuery = vi.fn(
    async (query: string) => ({
      rows: query.includes("RETURNING id")
        ? [{ id: 41 }]
        : []
    })
  );
  const release = vi.fn();
  const client = {
    query: clientQuery,
    release
  } as unknown as PoolClient;
  const query = vi.fn(async () => ({
    rows: snapshotRows
  }));
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
});
