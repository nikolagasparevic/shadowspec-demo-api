import { describe, expect, it, afterEach } from "vitest";
import { sanitizeObject } from "../src/sanitize";

describe("sanitizeObject", () => {
  afterEach(() => {
    delete process.env.SHADOWSPEC_REDACT_FIELDS;
  });

  it("removes default sensitive fields", () => {
    const result = sanitizeObject({
      username: "nikola",
      password: "super-secret",
      token: "abc123",
      email: "test@example.com"
    });

    expect(result).toEqual({
      username: "nikola",
      email: "test@example.com"
    });
  });

  it("matches sensitive fields case-insensitively", () => {
    const result = sanitizeObject({
      Password: "secret",
      TOKEN: "abc123",
      Authorization: "Bearer xyz",
      username: "nikola"
    });

    expect(result).toEqual({
      username: "nikola"
    });
  });

  it("sanitizes nested objects", () => {
    const result = sanitizeObject({
      user: {
        id: 123,
        profile: {
          name: "Nikola",
          password: "secret"
        }
      }
    });

    expect(result).toEqual({
      user: {
        id: 123,
        profile: {
          name: "Nikola"
        }
      }
    });
  });

  it("sanitizes objects inside arrays", () => {
    const result = sanitizeObject([
      {
        id: 1,
        token: "abc"
      },
      {
        id: 2,
        token: "def"
      }
    ]);

    expect(result).toEqual([
      {
        id: 1
      },
      {
        id: 2
      }
    ]);
  });

  it("preserves non-sensitive values", () => {
    const input = {
      id: 123,
      customerId: 456,
      quantity: 10,
      status: "created",
      active: true,
      metadata: null
    };

    expect(sanitizeObject(input)).toEqual(input);
  });

  it("supports custom sensitive fields from environment", () => {
    process.env.SHADOWSPEC_REDACT_FIELDS =
      "email,phoneNumber";

    const result = sanitizeObject({
      username: "nikola",
      email: "test@example.com",
      phoneNumber: "061123456",
      customerId: 123
    });

    expect(result).toEqual({
      username: "nikola",
      customerId: 123
    });
  });

  it("merges custom fields with default sensitive fields", () => {
    process.env.SHADOWSPEC_REDACT_FIELDS =
      "email";

    const result = sanitizeObject({
      email: "test@example.com",
      password: "secret",
      username: "nikola"
    });

    expect(result).toEqual({
      username: "nikola"
    });
  });
});