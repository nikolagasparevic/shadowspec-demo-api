import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  captureDatabaseSnapshot,
  SnapshotCaptureError
} from "../src/db-snapshot";

type TableFixture = {
  oid: string;
  columns: string[];
  primaryKey: string[];
  rows: Record<string, unknown>[];
};

function database(
  tables: Record<string, TableFixture>,
  fail?: (sql: string, table?: string) => unknown,
  relationOids: string[] = [],
  beforeQuery?: (sql: string) => Promise<void>
) {
  let relationCall = 0;
  const query = vi.fn(async (
    sql: string,
    parameters?: unknown[]
  ) => {
    await beforeQuery?.(sql);
    const table = parameters?.[1] as string | undefined;
    const failure = fail?.(sql, table);
    if (failure) throw failure;

    if (sql.includes("shadowspec:snapshot-relation")) {
      const fixture = tables[table!];
      return {
        rows: fixture
          ? [{
              oid: relationOids[relationCall++] ?? fixture.oid,
              relkind: "r",
              relpersistence: "p",
              has_inheritance: false
            }]
          : []
      };
    }
    if (sql.includes("shadowspec:snapshot-columns")) {
      const fixture = Object.values(tables).find(
        ({ oid }) => oid === parameters?.[0]
      )!;
      return {
        rows: fixture.columns.map((attname) => ({ attname }))
      };
    }
    if (sql.includes("shadowspec:snapshot-primary-key")) {
      const fixture = Object.values(tables).find(
        ({ oid }) => oid === parameters?.[0]
      )!;
      return {
        rows: fixture.primaryKey.map((attname, index) => ({
          attname,
          position: index + 1
        }))
      };
    }
    if (sql.startsWith("SELECT ")) {
      const entry = Object.entries(tables).find(([name]) =>
        sql.includes(`\"${name}\"`)
      );
      return { rows: entry?.[1].rows ?? [] };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  return { pool, connect, query, release };
}

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const books: TableFixture = {
  oid: "41",
  columns: ["title", "book_key"],
  primaryKey: ["book_key"],
  rows: [{ book_key: 7, title: "Dune" }]
};

describe("captureDatabaseSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("uses one client and one repeatable-read transaction", async () => {
    const db = database({ books });
    await expect(captureDatabaseSnapshot(
      db.pool,
      ["books"],
      { statementTimeoutMs: 1200 }
    )).resolves.toEqual({
      tables: { books: { rows: books.rows } }
    });

    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      "SET LOCAL statement_timeout = '1200ms'"
    );
    expect(db.query).toHaveBeenLastCalledWith("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("normalizes tables lexically and uses the same client for all reads", async () => {
    const db = database({
      authors: { ...books, oid: "42" },
      books
    });
    const snapshot = await captureDatabaseSnapshot(
      db.pool,
      [" books ", "authors", "", "books"]
    );

    expect(Object.keys(snapshot.tables)).toEqual(["authors", "books"]);
    const relationTables = db.query.mock.calls
      .filter(([sql]) => String(sql).includes("snapshot-relation"))
      .map(([, parameters]) => parameters?.[1]);
    expect(relationTables).toEqual([
      "authors", "authors", "books", "books"
    ]);
    expect(db.connect).toHaveBeenCalledOnce();
  });

  it("uses schema-qualified locks and reads without search_path", async () => {
    const db = database({ books });
    await captureDatabaseSnapshot(
      db.pool,
      ["books"],
      { schema: "catalog" }
    );
    const sql = db.query.mock.calls.map(([value]) => String(value));
    expect(sql).toContain(
      'LOCK TABLE "catalog"."books" IN ACCESS SHARE MODE'
    );
    expect(sql.some((value) =>
      value.includes('FROM ONLY "catalog"."books"')
    )).toBe(true);
    expect(sql.join("\n")).not.toContain("search_path");
  });

  it("rejects a relation replaced before its lock is trusted", async () => {
    const db = database({ books }, undefined, ["41", "42"]);
    await expect(captureDatabaseSnapshot(db.pool, ["books"]))
      .rejects.toMatchObject({ code: "SNAPSHOT_TABLE_UNSUPPORTED" });
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("selects lexical columns and orders by a non-id primary key", async () => {
    const db = database({ books });
    await captureDatabaseSnapshot(db.pool, ["books"]);
    const read = db.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.startsWith("SELECT "))!;
    expect(read).toContain('SELECT "book_key", "title"');
    expect(read).not.toContain("SELECT *");
    expect(read).toContain('ORDER BY "book_key" ASC');
  });

  it("preserves composite primary-key declaration order", async () => {
    const db = database({
      editions: {
        oid: "50",
        columns: ["author", "edition", "isbn"],
        primaryKey: ["isbn", "edition"],
        rows: []
      }
    });
    await captureDatabaseSnapshot(db.pool, ["editions"]);
    const read = db.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.startsWith("SELECT "))!;
    expect(read).toContain(
      'ORDER BY "isbn" ASC, "edition" ASC'
    );
  });

  it("accepts numeric, text, and UUID primary-key values", async () => {
    const db = database({
      numeric_keys: {
        oid: "61", columns: ["key"], primaryKey: ["key"], rows: [{ key: 1 }]
      },
      text_keys: {
        oid: "62", columns: ["key"], primaryKey: ["key"], rows: [{ key: "a" }]
      },
      uuid_keys: {
        oid: "63", columns: ["key"], primaryKey: ["key"], rows: [{ key: "11111111-1111-4111-8111-111111111111" }]
      }
    });
    await expect(captureDatabaseSnapshot(
      db.pool,
      ["uuid_keys", "numeric_keys", "text_keys"]
    )).resolves.toBeDefined();
  });

  it("rejects a table without a primary key", async () => {
    const db = database({ books: { ...books, primaryKey: [] } });
    await expect(captureDatabaseSnapshot(db.pool, ["books"]))
      .rejects.toMatchObject<Partial<SnapshotCaptureError>>({
        code: "SNAPSHOT_PRIMARY_KEY_REQUIRED"
      });
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("classifies PostgreSQL query cancellation as a timeout", async () => {
    const timeout = Object.assign(new Error("cancelled"), { code: "57014" });
    const db = database({ books }, (sql) =>
      sql.startsWith("SELECT ") ? timeout : undefined
    );
    await expect(captureDatabaseSnapshot(db.pool, ["books"]))
      .rejects.toMatchObject({ code: "SNAPSHOT_TIMEOUT" });
    expect(db.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SNAPSHOT_TIMEOUT" })
    );
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid total snapshot timeout %s",
    async (snapshotTimeoutMs) => {
      const db = database({ books });
      await expect(captureDatabaseSnapshot(
        db.pool,
        ["books"],
        { snapshotTimeoutMs }
      )).rejects.toMatchObject({
        code: "SNAPSHOT_CONFIGURATION_INVALID"
      });
      expect(db.connect).not.toHaveBeenCalled();
    }
  );

  it("starts the deadline before pool checkout", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(() => new Promise<PoolClient>(() => {}));
    const result = captureDatabaseSnapshot(
      { connect } as unknown as Pool,
      ["books"],
      { snapshotTimeoutMs: 20 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT",
      stage: "snapshot-connect"
    });

    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(connect).toHaveBeenCalledOnce();
  });

  it("discards a client that arrives after checkout timed out", async () => {
    vi.useFakeTimers();
    const checkout = pending<PoolClient>();
    const release = vi.fn();
    const result = captureDatabaseSnapshot(
      { connect: () => checkout.promise } as unknown as Pool,
      ["books"],
      { snapshotTimeoutMs: 10 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT"
    });

    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    checkout.resolve({ release } as unknown as PoolClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SNAPSHOT_TIMEOUT" })
    );
  });

  it("observes a late checkout rejection", async () => {
    vi.useFakeTimers();
    const checkout = pending<PoolClient>();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = captureDatabaseSnapshot(
        { connect: () => checkout.promise } as unknown as Pool,
        ["books"],
        { snapshotTimeoutMs: 10 }
      );
      const expectation = expect(result).rejects.toMatchObject({
        code: "SNAPSHOT_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(10);
      await expectation;
      checkout.reject(new Error("late connection failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("times out a hung transaction start and discards the client", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => new Promise(() => {}));
    const release = vi.fn();
    const pool = {
      connect: async () => ({ query, release } as unknown as PoolClient)
    } as unknown as Pool;
    const result = captureDatabaseSnapshot(
      pool,
      ["books"],
      { snapshotTimeoutMs: 15 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT",
      stage: "snapshot-transaction"
    });

    await vi.advanceTimersByTimeAsync(15);
    await expectation;
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("times out a hung table read and discards the client", async () => {
    vi.useFakeTimers();
    const db = database(
      { books },
      undefined,
      [],
      (sql) => sql.startsWith("SELECT ")
        ? new Promise(() => {})
        : Promise.resolve()
    );
    const result = captureDatabaseSnapshot(
      db.pool,
      ["books"],
      { snapshotTimeoutMs: 20 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT",
      stage: "snapshot-read"
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("enforces one total deadline across individually fast operations", async () => {
    vi.useFakeTimers();
    const db = database(
      { books },
      undefined,
      [],
      () => new Promise((resolve) => setTimeout(resolve, 2))
    );
    const result = captureDatabaseSnapshot(
      db.pool,
      ["books"],
      { snapshotTimeoutMs: 12, statementTimeoutMs: 10 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT"
    });

    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("caps local statement timeouts to the remaining total budget", async () => {
    const db = database({ books });
    await captureDatabaseSnapshot(db.pool, ["books"], {
      snapshotTimeoutMs: 50,
      statementTimeoutMs: 5000
    });
    const timeouts = db.query.mock.calls
      .map(([sql]) => /^SET LOCAL statement_timeout = '(\d+)ms'$/.exec(sql)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    expect(timeouts.length).toBeGreaterThanOrEqual(2);
    expect(timeouts.every((value) => value > 0 && value <= 50)).toBe(true);
  });

  it("rolls back and releases normally after an ordinary failure", async () => {
    const db = database({ books }, (sql) =>
      sql.includes("snapshot-relation") ? new Error("read failed") : undefined
    );
    await expect(captureDatabaseSnapshot(db.pool, ["books"]))
      .rejects.toMatchObject({ code: "SNAPSHOT_READ_FAILED" });
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith();
  });

  it("discards the client when rollback fails", async () => {
    const db = database({ books }, (sql) => {
      if (sql.includes("snapshot-relation")) return new Error("read failed");
      if (sql === "ROLLBACK") return new Error("rollback failed");
      return undefined;
    });
    await expect(captureDatabaseSnapshot(db.pool, ["books"]))
      .rejects.toMatchObject({ stage: "snapshot-cleanup" });
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("discards the client when rollback exceeds the deadline", async () => {
    vi.useFakeTimers();
    const db = database(
      { books },
      (sql) => sql.includes("snapshot-relation")
        ? new Error("read failed")
        : undefined,
      [],
      (sql) => sql === "ROLLBACK"
        ? new Promise(() => {})
        : Promise.resolve()
    );
    const result = captureDatabaseSnapshot(
      db.pool,
      ["books"],
      { snapshotTimeoutMs: 20 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT",
      stage: "snapshot-cleanup"
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("returns no snapshot and discards the client when COMMIT hangs", async () => {
    vi.useFakeTimers();
    const db = database(
      { books },
      undefined,
      [],
      (sql) => sql === "COMMIT"
        ? new Promise(() => {})
        : Promise.resolve()
    );
    const result = captureDatabaseSnapshot(
      db.pool,
      ["books"],
      { snapshotTimeoutMs: 20 }
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "SNAPSHOT_TIMEOUT",
      stage: "snapshot-transaction"
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("returns no partial snapshot and releases after a later table failure", async () => {
    const db = database(
      { authors: { ...books, oid: "42" }, books },
      (sql, table) =>
        sql.includes("snapshot-relation") && table === "books"
          ? new Error("read failed")
          : undefined
    );
    await expect(captureDatabaseSnapshot(
      db.pool,
      ["authors", "books"]
    )).rejects.toMatchObject({ code: "SNAPSHOT_READ_FAILED" });
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rejects snapshots that cannot be serialized", async () => {
    const db = database({
      books: { ...books, rows: [{ book_key: 1n, title: "Dune" }] }
    });
    await expect(captureDatabaseSnapshot(db.pool, ["books"]))
      .rejects.toMatchObject({
        code: "SNAPSHOT_SERIALIZATION_FAILED"
      });
  });
});
