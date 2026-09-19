import { describe, expect, it } from "vitest";
import {
  compareResponses,
  normalizeResponse
} from "../src/compare";

describe("normalizeResponse", () => {
  it("sorts object keys recursively without masking values", () => {
    expect(
      normalizeResponse({
        z: 1,
        nested: { b: 2, a: 1 },
        a: 3
      })
    ).toEqual({
      a: 3,
      nested: { a: 1, b: 2 },
      z: 1
    });
  });
});

describe("compareResponses", () => {
  const compare = (
    expected: unknown,
    actual: unknown,
    ignoredValues: {
      pointer: string;
      type: "string" | "number" | "boolean";
    }[] = []
  ) =>
    compareResponses(
      expected,
      actual,
      200,
      200,
      ignoredValues
    );

  it("compares root objects independent of key order", () => {
    expect(
      compare({ a: 1, b: 2 }, { b: 2, a: 1 })
        .passed
    ).toBe(true);
  });

  it("compares root arrays and nested arrays exactly", () => {
    expect(
      compare(
        [{ values: [1, 2] }],
        [{ values: [1, 2] }]
      ).passed
    ).toBe(true);
    expect(
      compare(
        [{ values: [1, 2] }],
        [{ values: [2, 1] }]
      ).passed
    ).toBe(false);
  });

  it.each([
    [{ value: 1 }, { value: 1, added: true }],
    [{ value: 1, removed: true }, { value: 1 }],
    [{ value: null }, {}],
    [{ value: 1 }, { value: "1" }],
    [[1], [1, 2]]
  ])("detects structural or type differences", (expected, actual) => {
    expect(compare(expected, actual).passed).toBe(false);
  });

  it("allows only an approved primitive value to differ", () => {
    const result = compare(
      {
        data: {
          requestId: "production",
          status: "created"
        }
      },
      {
        data: {
          requestId: "replay",
          status: "created"
        }
      },
      [{ pointer: "/data/requestId", type: "string" }]
    );

    expect(result.passed).toBe(true);
  });

  it("does not ignore siblings or the same key elsewhere", () => {
    const ignored = [
      { pointer: "/requestId", type: "string" as const }
    ];

    expect(
      compare(
        {
          requestId: "one",
          sibling: "stable",
          nested: { requestId: "stable" }
        },
        {
          requestId: "two",
          sibling: "changed",
          nested: { requestId: "stable" }
        },
        ignored
      ).passed
    ).toBe(false);

    expect(
      compare(
        {
          requestId: "one",
          nested: { requestId: "stable" }
        },
        {
          requestId: "two",
          nested: { requestId: "changed" }
        },
        ignored
      ).passed
    ).toBe(false);
  });

  it("supports exact array indexes and escaped pointer tokens", () => {
    expect(
      compare(
        {
          items: [
            { id: 1 },
            { id: 2 }
          ],
          "a/b": "one",
          "a~b": "one"
        },
        {
          items: [
            { id: 99 },
            { id: 2 }
          ],
          "a/b": "two",
          "a~b": "two"
        },
        [
          { pointer: "/items/0/id", type: "number" },
          { pointer: "/a~1b", type: "string" },
          { pointer: "/a~0b", type: "string" }
        ]
      ).passed
    ).toBe(true);
  });

  it("fails when an ignored pointer is missing from actual", () => {
    expect(
      compare(
        { requestId: "one" },
        {},
        [{ pointer: "/requestId", type: "string" }]
      ).passed
    ).toBe(false);
  });

  it("fails when an ignored value changes type", () => {
    expect(
      compare(
        { requestId: "one" },
        { requestId: 2 },
        [{ pointer: "/requestId", type: "string" }]
      ).passed
    ).toBe(false);
  });

  it.each([
    ["requestId", "INVALID_IGNORED_VALUE_POINTER"],
    ["", "INVALID_IGNORED_VALUE_POINTER"]
  ])("rejects invalid ignored pointer %s", (pointer, code) => {
    expect(() =>
      compare(
        { requestId: "one" },
        { requestId: "two" },
        [{ pointer, type: "string" }]
      )
    ).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it("rejects container ignored-value targets", () => {
    expect(() =>
      compare(
        { data: { id: 1 } },
        { data: { id: 2 } },
        [{ pointer: "/data", type: "string" }]
      )
    ).toThrowError(
      expect.objectContaining({
        code: "IGNORED_VALUE_TARGET_INVALID"
      })
    );
  });

  it("rejects overlapping ignored-value pointers", () => {
    expect(() =>
      compare(
        { data: { id: "one" } },
        { data: { id: "two" } },
        [
          { pointer: "/data", type: "string" },
          { pointer: "/data/id", type: "string" }
        ]
      )
    ).toThrowError(
      expect.objectContaining({
        code: "OVERLAPPING_IGNORED_VALUES"
      })
    );
  });

  it("still compares HTTP status exactly", () => {
    const result = compareResponses(
      { ok: true },
      { ok: true },
      200,
      404
    );

    expect(result.passed).toBe(false);
    expect(result.differences).toContainEqual({
      field: "httpStatus",
      expected: 200,
      actual: 404
    });
  });
});
