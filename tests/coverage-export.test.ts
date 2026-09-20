import { describe, expect, it } from "vitest";
import {
  buildCoverageExport,
  ScenarioExportError
} from "../src/export-scenarios";
import type {
  FrozenCaptureSet,
  PersistedCapture
} from "../src/export-captures";
import { REPLAY_TARGET_ENDPOINT } from "../src/replay-target-protocol";

function capture(
  id: number,
  overrides: Partial<PersistedCapture> = {}
): PersistedCapture {
  return {
    id,
    active: true,
    sessionId: null,
    method: "GET",
    path: `/resources/${id}`,
    pathParams: { id: String(id) },
    queryParams: {},
    requestBody: null,
    responseBody: { id, status: "ok" },
    responseStatus: 200,
    snapshots: [{
      tables: {
        resources: { rows: [{ id, status: "ok" }] }
      }
    }],
    ...overrides
  };
}

function frozen(captures: PersistedCapture[]): FrozenCaptureSet {
  return {
    maxVisibleCaptureId: captures.length
      ? Math.max(...captures.map(({ id }) => Number(id)))
      : null,
    captures
  };
}

function build(captures: PersistedCapture[]) {
  return buildCoverageExport(frozen(captures), "project-one");
}

describe("coverage-complete scenario construction", () => {
  it("maps ten repeated standalone captures to ten distinct checks", () => {
    const captures = Array.from({ length: 10 }, (_, index) =>
      capture(index + 1, {
        path: "/health",
        pathParams: {},
        responseBody: { status: "ok" }
      })
    );
    const result = build(captures);
    expect(result.scenarios).toHaveLength(10);
    expect(result.coverage.executableCaptures).toBe(10);
    expect(result.coverage.checkCount).toBe(10);
    expect(result.coverage.dispositions.map(({ captureId }) => captureId))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("fully reconciles mixed standalone, one-step session, and lifecycle captures", () => {
    const result = build([
      capture(1),
      capture(2, { sessionId: "single" }),
      capture(3, { sessionId: "life", method: "POST" }),
      capture(4, { sessionId: "life" })
    ]);
    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[1].steps).toBeUndefined();
    expect(result.scenarios[2].steps).toHaveLength(2);
    expect(result.coverage).toMatchObject({
      complete: true,
      executableCaptures: 4,
      rejectedCaptures: 0,
      excludedCaptures: 0,
      checkCount: 4
    });
  });

  it("rejects every member of a reused non-contiguous session", () => {
    const result = build([
      capture(1, { sessionId: "A" }),
      capture(2, { sessionId: "A" }),
      capture(3, { sessionId: "B" }),
      capture(4, { sessionId: "A" })
    ]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.dispositions.filter(({ captureId }) =>
      [1, 2, 4].includes(captureId)
    )).toSatisfy((items: typeof result.coverage.dispositions) =>
      items.every(({ disposition }) =>
        disposition === "REJECTED_LIFECYCLE_AMBIGUOUS"
      )
    );
  });

  it("rejects both interleaved sessions", () => {
    const result = build([
      capture(1, { sessionId: "A" }),
      capture(2, { sessionId: "B" }),
      capture(3, { sessionId: "A" }),
      capture(4, { sessionId: "B" })
    ]);
    expect(result.coverage.rejectedCaptures).toBe(4);
    expect(result.scenarios).toEqual([]);
  });

  it("keeps a non-qualifying binding lifecycle literal without dropping steps", () => {
    const result = build([
      capture(1, {
        sessionId: "flow",
        method: "POST",
        path: "/resources",
        pathParams: {},
        requestBody: { name: "one" },
        responseBody: { id: 12, name: "one" }
      }),
      capture(2, {
        sessionId: "flow",
        path: "/resources/12",
        pathParams: { id: "12" },
        responseBody: { id: 12, name: "one" }
      })
    ]);
    expect(result.scenarios[0].steps).toHaveLength(2);
    expect(result.scenarios[0].steps?.[1].request.pathParams)
      .toEqual({ id: "12" });
    expect(result.coverage.executableCaptures).toBe(2);
  });

  it.each([302, 404, 500])("keeps HTTP %i as executable expected behavior", (status) => {
    const result = build([capture(1, { responseStatus: status })]);
    expect(result.coverage.complete).toBe(true);
    expect(result.scenarios[0].expected.status).toBe(status);
  });

  it("excludes only the exact internal endpoint while keeping health executable", () => {
    const result = build([
      capture(1, { path: REPLAY_TARGET_ENDPOINT, pathParams: {} }),
      capture(2, { path: "/health", pathParams: {} })
    ]);
    expect(result.coverage).toMatchObject({
      complete: true,
      executableCaptures: 1,
      excludedCaptures: 1
    });
    expect(result.coverage.dispositions[0].disposition)
      .toBe("EXCLUDED_SHADOWSPEC_INTERNAL");
    expect(result.scenarios[0].request.path).toBe("/health");
  });

  it("accounts for an inactive capture as an explicit exclusion", () => {
    const result = build([capture(1, { active: false })]);
    expect(result.coverage).toMatchObject({
      complete: true,
      executableCaptures: 0,
      excludedCaptures: 1
    });
    expect(result.coverage.dispositions[0].disposition)
      .toBe("EXCLUDED_INACTIVE");
  });

  it.each([
    ["malformed", { method: null }, "CAPTURE_SHAPE_INVALID"],
    ["malformed JSON body", { responseBody: undefined }, "CAPTURE_SHAPE_INVALID"],
    ["malformed snapshot table", { snapshots: [{ tables: { x: {} } }] }, "CAPTURE_SHAPE_INVALID"],
    ["missing snapshot", { snapshots: [] }, "SNAPSHOT_MISSING"],
    ["duplicate snapshot", { snapshots: [{ tables: { x: { rows: [] } } }, { tables: { x: { rows: [] } } }] }, "SNAPSHOT_DUPLICATED"]
  ] as const)("rejects %s captures explicitly", (_label, overrides, reason) => {
    const result = build([capture(1, overrides)]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.dispositions[0]).toMatchObject({
      disposition: "REJECTED_INVALID_CAPTURE",
      reason
    });
  });

  it.each([
    ["request", { requestBody: { password: "request-secret" } }],
    ["query", { queryParams: { token: "query-secret" } }],
    ["response", { responseBody: { token: "response-secret" } }],
    ["snapshot", { snapshots: [{ tables: { x: { rows: [{ secret: "snapshot-secret" }] } } }] }]
  ] as const)("rejects replay-critical %s sanitization", (_label, overrides) => {
    const result = build([capture(1, overrides)]);
    expect(result.coverage.dispositions[0]).toMatchObject({
      disposition: "REJECTED_SANITIZATION",
      reason: "REPLAY_CRITICAL_DATA_REDACTED"
    });
  });

  it("rejects a whole lifecycle when one member is invalid", () => {
    const result = build([
      capture(1, { sessionId: "flow" }),
      capture(2, { sessionId: "flow", snapshots: [] })
    ]);
    expect(result.coverage.rejectedCaptures).toBe(2);
    expect(result.coverage.dispositions[0].reason)
      .toBe("LIFECYCLE_MEMBER_REJECTED");
    expect(result.coverage.dispositions[1].reason)
      .toBe("SNAPSHOT_MISSING");
  });

  it("rejects duplicate frozen capture identities before accounting", () => {
    expect(() => build([capture(1), capture(1)]))
      .toThrowError(ScenarioExportError);
  });
});
