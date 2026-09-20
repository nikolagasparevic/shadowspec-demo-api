import { describe, expect, it } from "vitest";
import {
  assertRequestPrivacy,
  assertResponsePrivacy,
  CapturePrivacyError,
  compileCapturePrivacyPolicy,
  type CapturePrivacyOptions
} from "../src/capture-privacy";

function request(
  options: CapturePrivacyOptions,
  overrides: Partial<Parameters<typeof assertRequestPrivacy>[1]> = {}
) {
  return () => assertRequestPrivacy(
    compileCapturePrivacyPolicy(options),
    {
      headers: {},
      body: undefined,
      query: {},
      pathParams: {},
      ...overrides
    }
  );
}

function expectPrivacyError(
  operation: () => unknown,
  code: CapturePrivacyError["code"],
  details: Partial<CapturePrivacyError> = {}
) {
  try {
    operation();
    throw new Error("Expected a privacy error.");
  } catch (error) {
    expect(error).toBeInstanceOf(CapturePrivacyError);
    expect(error).toMatchObject({ code, ...details });
  }
}

describe("capture privacy policy", () => {
  it("accepts a complete snapshot column inventory and normalizes column order", () => {
    const policy = compileCapturePrivacyPolicy({
      snapshotAllowedColumns: {
        books: ["title", "id"],
        authors: ["name", "id"]
      }
    }, ["books", "authors"]);

    expect(policy.snapshotAllowedColumns).toEqual({
      books: ["id", "title"],
      authors: ["id", "name"]
    });
  });

  it.each([
    ["missing table", { snapshotAllowedColumns: { books: ["id"] } },
      ["books", "authors"]],
    ["unknown table", { snapshotAllowedColumns: {
      books: ["id"], authors: ["id"]
    } }, ["books"]],
    ["duplicate column", { snapshotAllowedColumns: {
      books: ["id", " id "]
    } }, ["books"]],
    ["invalid table", { snapshotAllowedColumns: {
      "bad-table": ["id"]
    } }, ["bad-table"]],
    ["invalid column", { snapshotAllowedColumns: {
      books: ["bad-column"]
    } }, ["books"]]
  ] as const)("rejects %s snapshot configuration", (_label, options, tables) => {
    expectPrivacyError(
      () => compileCapturePrivacyPolicy(options, tables),
      "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
    );
  });

  it.each([
    "body/password",
    "/unknown/value",
    "/body/bad~escape",
    "/body/bad~2escape"
  ])("rejects malformed request pointer %s", (pointer) => {
    expectPrivacyError(
      () => compileCapturePrivacyPolicy({
        forbiddenRequestPointers: [pointer]
      }),
      "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
    );
  });

  it("rejects malformed response roots", () => {
    expectPrivacyError(
      () => compileCapturePrivacyPolicy({
        forbiddenResponsePointers: ["/query/token"]
      }),
      "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
    );
  });

  it("rejects duplicate pointers", () => {
    expectPrivacyError(
      () => compileCapturePrivacyPolicy({
        forbiddenRequestPointers: ["/body/id", "/body/id"]
      }),
      "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
    );
  });

  it.each([
    ["authorization", "Authorization"],
    ["configured header", "X-API-Key", "x-api-key"]
  ])("rejects duplicate normalized %s", (_label, first, second = first) => {
    expectPrivacyError(
      () => compileCapturePrivacyPolicy({
        forbiddenHeaders: [first, second]
      }),
      "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
    );
  });

  it.each(["", "bad header", "bad:header"])(
    "rejects invalid header name %j",
    (header) => {
      expectPrivacyError(
        () => compileCapturePrivacyPolicy({ forbiddenHeaders: [header] }),
        "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
      );
    }
  );

  it.each(["Authorization", "aUtHoRiZaTiOn", "Cookie"])(
    "rejects protocol header %s case-insensitively",
    (header) => {
      expectPrivacyError(
        request({}, { headers: { [header]: "unlogged-secret" } }),
        "CAPTURE_SECRET_REPLAY_REQUIRED",
        { location: "header", headerName: header.toLowerCase() }
      );
    }
  );

  it("rejects a configured forbidden header", () => {
    expectPrivacyError(
      request(
        { forbiddenHeaders: ["X-API-Key"] },
        { headers: { "x-api-key": "unlogged-secret" } }
      ),
      "CAPTURE_SECRET_REPLAY_REQUIRED",
      { headerName: "x-api-key" }
    );
  });

  it("does not treat the ShadowSpec session header as a credential", () => {
    expect(request({}, {
      headers: { "x-shadowspec-session-id": "capture-session" }
    })).not.toThrow();
  });

  it.each([
    ["body", "/body/password", { body: { password: "secret" } }],
    ["query", "/query/token", { query: { token: "secret" } }],
    ["path", "/pathParams/customerId", {
      pathParams: { customerId: "7" }
    }],
    ["nested", "/body/user/credentials/value", {
      body: { user: { credentials: { value: "secret" } } }
    }],
    ["array", "/body/users/0/secret", {
      body: { users: [{ secret: "value" }] }
    }],
    ["escaped", "/body/a~1b/~0value", {
      body: { "a/b": { "~value": "secret" } }
    }]
  ])("matches an exact %s request pointer", (_label, pointer, overrides) => {
    expectPrivacyError(
      request({ forbiddenRequestPointers: [pointer] }, overrides),
      "CAPTURE_PRIVACY_POLICY_VIOLATION",
      { pointer }
    );
  });

  it("does not reject a missing exact pointer", () => {
    expect(request(
      { forbiddenRequestPointers: ["/body/password"] },
      { body: { passwordHint: "safe" } }
    )).not.toThrow();
  });

  it.each([null, false, 0, "", {}, []])(
    "rejects an existing pointer containing %j",
    (value) => {
      expectPrivacyError(
        request(
          { forbiddenRequestPointers: ["/body/value"] },
          { body: { value } }
        ),
        "CAPTURE_PRIVACY_POLICY_VIOLATION"
      );
    }
  );

  it("supports exact request root targeting", () => {
    expectPrivacyError(
      request(
        { forbiddenRequestPointers: ["/body"] },
        { body: {} }
      ),
      "CAPTURE_PRIVACY_POLICY_VIOLATION",
      { location: "request-body" }
    );
    expect(request({ forbiddenRequestPointers: ["/body"] }))
      .not.toThrow();
  });

  it("supports exact response pointers and root targeting", () => {
    const nested = compileCapturePrivacyPolicy({
      forbiddenResponsePointers: ["/body/data/token"]
    });
    expectPrivacyError(
      () => assertResponsePrivacy(nested, { data: { token: null } }),
      "CAPTURE_PRIVACY_POLICY_VIOLATION",
      { location: "response-body", pointer: "/body/data/token" }
    );

    const root = compileCapturePrivacyPolicy({
      forbiddenResponsePointers: ["/body"]
    });
    expectPrivacyError(
      () => assertResponsePrivacy(root, ""),
      "CAPTURE_PRIVACY_POLICY_VIOLATION"
    );
  });

  it("does not heuristically reject sensitive-looking keys", () => {
    expect(request({}, {
      body: { password: "not-inspected-in-this-slice", token: "value" }
    })).not.toThrow();
  });

  it("leaves SHADOWSPEC_REDACT_FIELDS as export-only compatibility behavior", () => {
    process.env.SHADOWSPEC_REDACT_FIELDS = "privateToken";
    try {
      expect(request({}, {
        body: { privateToken: "not-pre-persistence-policy" }
      })).not.toThrow();
    } finally {
      delete process.env.SHADOWSPEC_REDACT_FIELDS;
    }
  });
});
