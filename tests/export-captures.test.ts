import { describe, expect, it, vi } from "vitest";
import { loadFrozenCaptureSet } from "../src/export-captures";

function clientWithRows(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("MAX(id)")) {
      return { rows: [{ max_id: 9 }] };
    }
    if (sql.includes("FROM api_requests r")) {
      return { rows };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect }, query, release, connect };
}

function row(id: number, snapshotId: number | null = id) {
  return {
    id,
    active: true,
    session_id: null,
    method: "GET",
    path: `/resources/${id}`,
    path_params: { id: String(id) },
    query_params: {},
    request_body: null,
    response_body: { id },
    response_status: 200,
    snapshot_id: snapshotId,
    snapshot: snapshotId === null
      ? null
      : { tables: { resources: { rows: [] } } }
  };
}

describe("frozen capture loading", () => {
  it("uses one checked-out client and a read-only repeatable-read transaction", async () => {
    const fixture = clientWithRows([row(2), row(9)]);
    const result = await loadFrozenCaptureSet(fixture.pool as never);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT MAX(id) AS max_id FROM api_requests",
      expect.stringContaining("LEFT JOIN api_request_snapshots"),
      "COMMIT"
    ]);
    expect(fixture.query.mock.calls[2][1]).toEqual([9]);
    expect(result).toMatchObject({
      maxVisibleCaptureId: 9,
      captures: [{ id: 2 }, { id: 9 }]
    });
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("retains inactive captures, sequence gaps, and deterministic ID order", async () => {
    const inactive = { ...row(2), active: false };
    const fixture = clientWithRows([inactive, row(9)]);
    const result = await loadFrozenCaptureSet(fixture.pool as never);
    expect(result.captures.map(({ id }) => id)).toEqual([2, 9]);
    expect(result.captures[0].active).toBe(false);
  });

  it("preserves zero, one, and duplicate snapshot cardinality", async () => {
    const fixture = clientWithRows([
      row(1, null),
      row(2, 20),
      row(3, 30),
      { ...row(3, 31), snapshot: { tables: { other: { rows: [] } } } }
    ]);
    const result = await loadFrozenCaptureSet(fixture.pool as never);
    expect(result.captures.map(({ snapshots }) => snapshots.length))
      .toEqual([0, 1, 2]);
  });

  it("rolls back and releases the same client when a frozen read fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("BEGIN")) return { rows: [] };
      if (sql.includes("MAX(id)")) throw new Error("read failed");
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release }))
    };
    await expect(loadFrozenCaptureSet(pool as never))
      .rejects.toThrow("read failed");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns an empty frozen scope without issuing the joined read", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("MAX(id)")
        ? { rows: [{ max_id: null }] }
        : { rows: [] }
    );
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };
    await expect(loadFrozenCaptureSet(pool as never)).resolves.toEqual({
      maxVisibleCaptureId: null,
      captures: []
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("FROM api_requests r")
    )).toBe(false);
  });
});
