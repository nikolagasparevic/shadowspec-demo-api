import { describe, expect, it } from "vitest";
import { detectDynamicCandidates } from "../src/dynamic-fields";

describe("detectDynamicCandidates", () => {
  it("returns no candidates for one or identical responses", () => {
    expect(
      detectDynamicCandidates([{ status: "pending" }])
    ).toEqual([]);
    expect(
      detectDynamicCandidates([
        { status: "pending" },
        { status: "pending" }
      ])
    ).toEqual([]);
  });

  it.each([
    ["status", "pending", "approved"],
    ["price", 10, 11],
    ["updatedAt", "2026-01-01", "2026-01-02"],
    ["requestId", "request-a", "request-b"],
    ["cursor", "cursor-a", "cursor-b"]
  ])("reports %s variation as a candidate only", (field, left, right) => {
    expect(
      detectDynamicCandidates([
        { [field]: left },
        { [field]: right }
      ])
    ).toEqual([
      {
        pointer: `/${field}`,
        reason: "value_changed",
        observedTypes: [typeof left],
        presentCount: 2,
        captureCount: 2,
        distinctValueCount: 2
      }
    ]);
  });

  it("reports nested and escaped exact pointers deterministically", () => {
    const candidates = detectDynamicCandidates([
      {
        data: {
          "a/b": "one",
          "a~b": "one",
          requestId: "one"
        }
      },
      {
        data: {
          "a/b": "two",
          "a~b": "two",
          requestId: "two"
        }
      }
    ]);

    expect(
      candidates.map((candidate) => candidate.pointer)
    ).toEqual([
      "/data/a~0b",
      "/data/a~1b",
      "/data/requestId"
    ]);
  });

  it("reports presence, null, and type changes", () => {
    expect(
      detectDynamicCandidates([
        { present: "yes", nullable: null, typed: 1 },
        { nullable: "value", typed: "1" }
      ]).map(({ pointer, reason }) => ({
        pointer,
        reason
      }))
    ).toEqual([
      { pointer: "/nullable", reason: "type_changed" },
      { pointer: "/present", reason: "presence_changed" },
      { pointer: "/typed", reason: "type_changed" }
    ]);
  });

  it("uses exact array indexes and exposes moves", () => {
    expect(
      detectDynamicCandidates([
        { items: [{ id: 1 }, { id: 2 }] },
        { items: [{ id: 2 }, { id: 1 }] }
      ]).map((candidate) => candidate.pointer)
    ).toEqual([
      "/items/0/id",
      "/items/1/id"
    ]);
  });

  it("reports an added array element without masking the array", () => {
    expect(
      detectDynamicCandidates([
        { items: [{ id: 1 }] },
        { items: [{ id: 1 }, { id: 2 }] }
      ])
    ).toEqual([
      {
        pointer: "/items/1",
        reason: "presence_changed",
        observedTypes: ["object"],
        presentCount: 1,
        captureCount: 2,
        distinctValueCount: 1
      }
    ]);
  });
});
