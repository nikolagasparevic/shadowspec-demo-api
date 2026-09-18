import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { compareResponses } from "../src/compare";
import {
  captureBindings,
  preflightLifecycleBindings,
  resolveBindingReferences,
  resolvePathParams,
  type BindingStore
} from "../src/lifecycle-bindings";
import { replayRequest } from "../src/replay";
import { computeReplayTargetProof } from "../src/replay-target-protocol";
import type { CaptureDefinition } from "../src/load-scenarios";

describe("lifecycle bindings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SHADOWSPEC_TARGET_URL;
    delete process.env.SHADOWSPEC_PROJECT_ID;
    delete process.env.SHADOWSPEC_REPLAY_DATABASE_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN;
  });

  it("allows a replay-generated value to differ on its capture step", () => {
    const bindings: BindingStore =
      new Map();

    const ignoredPointers =
      captureBindings(
        {
          orderId: {
            from: "response.body",
            pointer: "/orderId",
            type: "number"
          }
        },
        {
          orderId: 12,
          status: "created"
        },
        bindings
      );

    const comparison = compareResponses(
      {
        orderId: 8372,
        status: "created"
      },
      {
        orderId: 12,
        status: "created"
      },
      201,
      201,
      [],
      ignoredPointers
    );

    expect(comparison.passed).toBe(true);
    expect(bindings.get("orderId")).toBe(12);

    expect(
      compareResponses(
        {
          orderId: 8372,
          status: "created"
        },
        {
          orderId: 12,
          status: "cancelled"
        },
        201,
        201,
        [],
        ignoredPointers
      ).passed
    ).toBe(false);
  });

  it("sends the captured value in a later request path", async () => {
    const projectId =
      "11111111-1111-4111-8111-111111111111";
    const databaseId =
      "22222222-2222-4222-8222-222222222222";
    const targetId =
      "33333333-3333-4333-8333-333333333333";
    const token =
      "target-token-0123456789-abcdefghij";
    process.env.SHADOWSPEC_TARGET_URL =
      "http://localhost:3001";
    process.env.SHADOWSPEC_PROJECT_ID = projectId;
    process.env.SHADOWSPEC_REPLAY_DATABASE_ID =
      databaseId;
    process.env.SHADOWSPEC_REPLAY_TARGET_ID = targetId;
    process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN = token;
    const fetchMock = vi.fn(
      async (_url: string, options: RequestInit) => {
        if (options.method === "POST") {
          const challenge = JSON.parse(
            options.body as string
          ) as { nonce: string };
          return new Response(
            JSON.stringify({
              protocolVersion: 1,
              projectId,
              replayDatabaseId: databaseId,
              replayTargetId: targetId,
              proof: computeReplayTargetProof(
                token,
                challenge.nonce,
                projectId,
                databaseId,
                targetId
              )
            }),
            { status: 200 }
          );
        }

        return new Response(
          JSON.stringify({ orderId: 12 }),
          { status: 200 }
        );
      }
    );

    vi.stubGlobal("fetch", fetchMock);

    const pathParams = resolvePathParams(
      {
        id: {
          $ref: "orderId"
        }
      },
      new Map([["orderId", 12]])
    );

    await replayRequest(
      "GET",
      "/orders/:id",
      null,
      pathParams
    );

    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:3001/orders/12",
      {
        method: "GET",
        redirect: "manual"
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("compares a later response against the replay-generated value", () => {
    const bindings: BindingStore =
      new Map([["orderId", 12]]);

    const expected = resolveBindingReferences(
      {
        orderId: {
          $ref: "orderId"
        },
        status: "created"
      },
      bindings
    );

    expect(
      compareResponses(
        expected,
        {
          orderId: 12,
          status: "created"
        },
        200,
        200
      ).passed
    ).toBe(true);

    expect(
      compareResponses(
        expected,
        {
          orderId: 13,
          status: "created"
        },
        200,
        200
      ).passed
    ).toBe(false);
  });

  it("fails clearly for an unresolved reference", () => {
    expect(() =>
      resolvePathParams(
        {
          id: {
            $ref: "missingOrderId"
          }
        },
        new Map()
      )
    ).toThrow(
      'Unresolved ShadowSpec binding: "missingOrderId".'
    );
  });

  it("fails clearly when a capture pointer is missing", () => {
    expect(() =>
      captureBindings(
        {
          orderId: {
            from: "response.body",
            pointer: "/orderId",
            type: "number"
          }
        },
        {
          status: "created"
        },
        new Map()
      )
    ).toThrow(
      'ShadowSpec capture "orderId" could not find response body pointer "/orderId".'
    );
  });

  it("rejects unsupported capture sources", () => {
    const definitions = {
      orderId: {
        from: "response.headers",
        pointer: "/orderId",
        type: "number"
      }
    } as unknown as Record<
      string,
      CaptureDefinition
    >;

    expect(() =>
      captureBindings(
        definitions,
        {
          orderId: 12
        },
        new Map()
      )
    ).toThrow(
      'ShadowSpec capture "orderId" has unsupported source "response.headers".'
    );
  });

  it("validates the declared capture type", () => {
    expect(() =>
      captureBindings(
        {
          orderId: {
            from: "response.body",
            pointer: "/orderId",
            type: "number"
          }
        },
        {
          orderId: "12"
        },
        new Map()
      )
    ).toThrow(
      'ShadowSpec capture "orderId" expected number at "/orderId", but received string.'
    );
  });

  it("captures nested scalar values with a JSON Pointer", () => {
    const bindings: BindingStore =
      new Map();

    captureBindings(
      {
        itemId: {
          from: "response.body",
          pointer: "/data/items/0/id",
          type: "string"
        }
      },
      {
        data: {
          items: [
            {
              id: "item-12"
            }
          ]
        }
      },
      bindings
    );

    expect(bindings.get("itemId")).toBe(
      "item-12"
    );
  });

  it("decodes escaped JSON Pointer tokens", () => {
    const bindings: BindingStore =
      new Map();

    captureBindings(
      {
        escapedValue: {
          from: "response.body",
          pointer: "/a~1b/~0value",
          type: "string"
        }
      },
      {
        "a/b": {
          "~value": "captured"
        }
      },
      bindings
    );

    expect(
      bindings.get("escapedValue")
    ).toBe("captured");
  });

  it("rejects duplicate binding names", () => {
    const bindings: BindingStore =
      new Map([["orderId", 12]]);

    expect(() =>
      captureBindings(
        {
          orderId: {
            from: "response.body",
            pointer: "/orderId",
            type: "number"
          }
        },
        {
          orderId: 13
        },
        bindings
      )
    ).toThrow(
      'ShadowSpec binding "orderId" is already defined.'
    );
  });

  it("resolves nested expected-body references", () => {
    const resolved =
      resolveBindingReferences(
        {
          data: {
            order: {
              id: {
                $ref: "orderId"
              }
            }
          }
        },
        new Map([["orderId", 12]])
      );

    expect(resolved).toEqual({
      data: {
        order: {
          id: 12
        }
      }
    });
  });

  it("isolates bindings between scenarios", () => {
    const firstScenario: BindingStore =
      new Map();

    captureBindings(
      {
        orderId: {
          from: "response.body",
          pointer: "/orderId",
          type: "number"
        }
      },
      {
        orderId: 12
      },
      firstScenario
    );

    const secondScenario: BindingStore =
      new Map();

    expect(
      firstScenario.get("orderId")
    ).toBe(12);

    expect(() =>
      resolvePathParams(
        {
          id: {
            $ref: "orderId"
          }
        },
        secondScenario
      )
    ).toThrow(
      'Unresolved ShadowSpec binding: "orderId".'
    );
  });

  it("leaves legacy literal lifecycle values unchanged", () => {
    const bindings: BindingStore =
      new Map();

    expect(
      resolvePathParams(
        {
          id: "3"
        },
        bindings
      )
    ).toEqual({
      id: "3"
    });

    expect(
      resolveBindingReferences(
        {
          orderId: 3
        },
        bindings
      )
    ).toEqual({
      orderId: 3
    });
  });

  it("preflights expected refs to previous bindings", () => {
    const bindings: BindingStore =
      new Map([["orderId", 12]]);

    expect(
      preflightLifecycleBindings(
        {},
        {
          orderId: { $ref: "orderId" }
        },
        undefined,
        bindings
      )
    ).toEqual({});
  });

  it("preflights expected refs declared by same-step captures", () => {
    const bindings: BindingStore =
      new Map();

    expect(
      preflightLifecycleBindings(
        {},
        {
          orderId: { $ref: "orderId" }
        },
        {
          orderId: {
            from: "response.body",
            pointer: "/orderId",
            type: "number"
          }
        },
        bindings
      )
    ).toEqual({});

    expect(bindings.size).toBe(0);
  });

  it("rejects unknown expected refs during preflight", () => {
    expect(() =>
      preflightLifecycleBindings(
        {},
        { id: { $ref: "missing" } },
        undefined,
        new Map()
      )
    ).toThrow(
      'Unresolved ShadowSpec binding: "missing".'
    );
  });

  it("rejects duplicate captures during preflight", () => {
    expect(() =>
      preflightLifecycleBindings(
        {},
        {},
        {
          orderId: {
            from: "response.body",
            pointer: "/orderId",
            type: "number"
          }
        },
        new Map([["orderId", 12]])
      )
    ).toThrow(
      'ShadowSpec binding "orderId" is already defined.'
    );
  });

  it("rejects unsupported capture sources during preflight", () => {
    const definitions = {
      orderId: {
        from: "response.headers",
        pointer: "/orderId",
        type: "number"
      }
    } as unknown as Record<
      string,
      CaptureDefinition
    >;

    expect(() =>
      preflightLifecycleBindings(
        {},
        {},
        definitions,
        new Map()
      )
    ).toThrow(
      'ShadowSpec capture "orderId" has unsupported source "response.headers".'
    );
  });

  it("rejects invalid capture pointers during preflight", () => {
    expect(() =>
      preflightLifecycleBindings(
        {},
        {},
        {
          orderId: {
            from: "response.body",
            pointer: "/invalid~2token",
            type: "number"
          }
        },
        new Map()
      )
    ).toThrow(
      "Invalid JSON Pointer token: invalid~2token"
    );
  });

  it("accepts root capture pointers during preflight", () => {
    expect(
      preflightLifecycleBindings(
        {},
        {},
        {
          value: {
            from: "response.body",
            pointer: "",
            type: "string"
          }
        },
        new Map()
      )
    ).toEqual({});
  });

  it("accepts escaped capture pointers during preflight", () => {
    expect(
      preflightLifecycleBindings(
        {},
        {},
        {
          value: {
            from: "response.body",
            pointer: "/a~1b/~0value",
            type: "string"
          }
        },
        new Map()
      )
    ).toEqual({});
  });

  it("does not modify bindings during preflight", () => {
    const bindings: BindingStore =
      new Map([["existing", 7]]);

    preflightLifecycleBindings(
      {},
      {
        previous: { $ref: "existing" },
        current: { $ref: "newValue" }
      },
      {
        newValue: {
          from: "response.body",
          pointer: "/newValue",
          type: "number"
        }
      },
      bindings
    );

    expect(
      Array.from(bindings.entries())
    ).toEqual([["existing", 7]]);
  });
});
