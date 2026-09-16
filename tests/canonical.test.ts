import { describe, expect, it } from "vitest";
import {
  canonicalize,
  canonicalStringify
} from "../src/canonical";

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    const value = {
      z: 1,
      nested: {
        b: 2,
        a: 1
      },
      a: 3
    };

    expect(canonicalize(value)).toEqual({
      a: 3,
      nested: {
        a: 1,
        b: 2
      },
      z: 1
    });
  });

  it("preserves array order", () => {
    const value = {
      items: [
        { id: 2 },
        { id: 1 }
      ]
    };

    expect(canonicalize(value)).toEqual({
      items: [
        { id: 2 },
        { id: 1 }
      ]
    });
  });
});

describe("canonicalStringify", () => {
  it("produces the same string for different object key orders", () => {
    const first = {
      customerId: 1234,
      productId: 5678,
      quantity: 10
    };

    const second = {
      quantity: 10,
      productId: 5678,
      customerId: 1234
    };

    expect(
      canonicalStringify(first)
    ).toBe(
      canonicalStringify(second)
    );
  });
});