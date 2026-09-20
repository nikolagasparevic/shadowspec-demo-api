import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  recordApiRequest,
  CaptureRecordError
} from "../src/recorder";

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function database(
  beforeQuery?: (sql: string) => Promise<void>,
  fail?: (sql: string) => unknown
) {
  const query = vi.fn(async (sql: string) => {
    await beforeQuery?.(sql);
    const failure = fail?.(sql);
    if (failure) throw failure;
    return {
      rows: sql.includes("RETURNING id") ? [{ id: 41 }] : []
    };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  return {
    pool: { connect } as unknown as Pool,
    client,
    connect,
    query,
    release
  };
}

function record(pool: Pool, timeoutMs = 5000) {
  return recordApiRequest(
    pool,
    "POST",
    "/books",
    { title: "Dune" },
    {},
    {},
    201,
    { bookId: 41 },
    { tables: { books: { rows: [] } } },
    "session-1",
    { timeoutMs }
  );
}

describe("recordApiRequest deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves successful atomic recording", async () => {
    const db = database();
    await record(db.pool);
    expect(db.query).toHaveBeenCalledWith("BEGIN");
    expect(db.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO")
    )).toHaveLength(2);
    expect(db.query).toHaveBeenCalledWith("COMMIT");
    expect(db.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith();
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid recorder timeout %s",
    async (timeoutMs) => {
      const db = database();
      await expect(record(db.pool, timeoutMs)).rejects.toBeInstanceOf(
        CaptureRecordError
      );
      expect(db.connect).not.toHaveBeenCalled();
    }
  );

  it("starts the deadline before capture-pool checkout", async () => {
    vi.useFakeTimers();
    const result = record(
      { connect: () => new Promise<PoolClient>(() => {}) } as unknown as Pool,
      10
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "CAPTURE_RECORD_TIMEOUT",
      stage: "recorder-connect"
    });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
  });

  it("discards a recorder client that arrives after checkout timeout", async () => {
    vi.useFakeTimers();
    const checkout = pending<PoolClient>();
    const release = vi.fn();
    const result = record(
      { connect: () => checkout.promise } as unknown as Pool,
      10
    );
    const expectation = expect(result).rejects.toMatchObject({
      code: "CAPTURE_RECORD_TIMEOUT"
    });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    checkout.resolve({ release } as unknown as PoolClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledWith(expect.any(CaptureRecordError));
  });

  it("observes a late recorder checkout rejection", async () => {
    vi.useFakeTimers();
    const checkout = pending<PoolClient>();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = record(
        { connect: () => checkout.promise } as unknown as Pool,
        10
      );
      const expectation = expect(result).rejects.toMatchObject({
        code: "CAPTURE_RECORD_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(10);
      await expectation;
      checkout.reject(new Error("late connect error"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each([
    ["BEGIN", "recorder-transaction"],
    ["INSERT INTO api_requests", "recorder-insert"],
    ["INSERT INTO api_request_snapshots", "recorder-insert"],
    ["COMMIT", "recorder-commit"]
  ] as const)("times out a hung %s operation", async (match, stage) => {
    vi.useFakeTimers();
    const db = database((sql) =>
      sql.includes(match) ? new Promise(() => {}) : Promise.resolve()
    );
    const result = record(db.pool, 20);
    const expectation = expect(result).rejects.toMatchObject({
      code: "CAPTURE_RECORD_TIMEOUT",
      stage
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(CaptureRecordError));
    expect(db.query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("does not commit when the snapshot insert times out", async () => {
    vi.useFakeTimers();
    const db = database((sql) =>
      sql.includes("INSERT INTO api_request_snapshots")
        ? new Promise(() => {})
        : Promise.resolve()
    );
    const result = record(db.pool, 10);
    const expectation = expect(result).rejects.toMatchObject({
      code: "CAPTURE_RECORD_TIMEOUT"
    });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    expect(db.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("enforces one total budget across individually fast operations", async () => {
    vi.useFakeTimers();
    const db = database(
      () => new Promise((resolve) => setTimeout(resolve, 3))
    );
    const result = record(db.pool, 12);
    const expectation = expect(result).rejects.toMatchObject({
      code: "CAPTURE_RECORD_TIMEOUT"
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(CaptureRecordError));
  });

  it("caps the transaction-local statement timeout to the total budget", async () => {
    const db = database();
    await record(db.pool, 50);
    const call = db.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("SET LOCAL statement_timeout")
    );
    const timeout = Number(/'(\d+)ms'/.exec(String(call?.[0]))?.[1]);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(50);
  });

  it("rolls back and releases normally after an ordinary insert failure", async () => {
    const db = database(undefined, (sql) =>
      sql.includes("INSERT INTO api_requests")
        ? new Error("insert failed")
        : undefined
    );
    await expect(record(db.pool)).rejects.toThrow("insert failed");
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith();
  });

  it("discards the client when rollback fails", async () => {
    const db = database(undefined, (sql) => {
      if (sql.includes("INSERT INTO api_requests")) return new Error("insert");
      if (sql === "ROLLBACK") return new Error("rollback");
      return undefined;
    });
    await expect(record(db.pool)).rejects.toMatchObject({
      code: "CAPTURE_CLEANUP_FAILED",
      stage: "recorder-cleanup"
    });
    expect(db.release).toHaveBeenCalledWith(expect.any(CaptureRecordError));
  });

  it("discards the client when rollback exceeds the deadline", async () => {
    vi.useFakeTimers();
    const db = database(
      (sql) => sql === "ROLLBACK" ? new Promise(() => {}) : Promise.resolve(),
      (sql) => sql.includes("INSERT INTO api_requests")
        ? new Error("insert")
        : undefined
    );
    const result = record(db.pool, 20);
    const expectation = expect(result).rejects.toMatchObject({
      code: "CAPTURE_RECORD_TIMEOUT",
      stage: "recorder-cleanup"
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(db.release).toHaveBeenCalledWith(expect.any(CaptureRecordError));
  });
});
