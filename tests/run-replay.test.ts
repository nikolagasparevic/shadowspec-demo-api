import {
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  runReplay,
  type ReplayDependencies
} from "../src/run-replay";
import type {
  CaptureDefinition,
  ShadowSpecScenario,
  ShadowSpecStep
} from "../src/load-scenarios";
import type {
  ShadowSpecReport
} from "../src/report";

type ReplayResult = {
  status: number;
  body: unknown;
};

function step(
  overrides: Partial<ShadowSpecStep> = {}
): ShadowSpecStep {
  return {
    request: {
      method: "GET",
      path: "/resource",
      body: null
    },
    expected: {
      status: 200,
      body: {
        status: "ok"
      }
    },
    ...overrides
  };
}

function lifecycleScenario(
  steps: ShadowSpecStep[],
  id = 1
): ShadowSpecScenario {
  return {
    id,
    request: steps[0].request,
    expected: steps[0].expected,
    steps
  };
}

function standaloneScenario(
  id = 1
): ShadowSpecScenario {
  return {
    id,
    request: {
      method: "GET",
      path: "/standalone",
      body: null
    },
    expected: {
      status: 200,
      body: {
        status: "ok"
      }
    }
  };
}

async function execute(
  scenarios: ShadowSpecScenario[],
  responses: ReplayResult[] = [],
  overrides: Partial<ReplayDependencies> = {}
) {
  const responseQueue = [...responses];
  const replayMock = vi.fn(
    async () => {
      const response = responseQueue.shift();

      if (!response) {
        throw new Error(
          "No replay response configured."
        );
      }

      return response;
    }
  );
  const setupMock = vi.fn(
    async () => undefined
  );
  const preflightMock = vi.fn(
    async () => undefined
  );
  const targetVerificationMock = vi.fn(
    async () => undefined
  );
  const writes: {
    path: string;
    contents: string;
  }[] = [];
  const logs: unknown[][] = [];
  let error: unknown;

  try {
    await runReplay({
      loadScenarios: () => scenarios,
      replayRequest: replayMock,
      applyReplaySetup: setupMock,
      preflightReplaySafety: preflightMock,
      verifyReplayTarget:
        targetVerificationMock,
      writeReportFile: (
        path,
        contents
      ) => {
        writes.push({ path, contents });
      },
      log: (...values) => {
        logs.push(values);
      },
      ...overrides
    });
  } catch (caught) {
    error = caught;
  }

  const report = writes.length > 0
    ? JSON.parse(
        writes[writes.length - 1].contents
      ) as ShadowSpecReport
    : undefined;

  return {
    error,
    report,
    replayMock,
    setupMock,
    preflightMock,
    targetVerificationMock,
    writes,
    logs
  };
}

function expectBindingFailure(
  report: ShadowSpecReport | undefined,
  code: string
) {
  expect(report?.failures).toHaveLength(1);
  expect(report?.failures[0]).toMatchObject({
    kind: "binding",
    code,
    differences: []
  });
}

describe("structured lifecycle binding failures", () => {
  it("performs no setup or scenario request after startup target refusal", async () => {
    const targetError = Object.assign(
      new Error("Replay target refused."),
      { code: "REPLAY_TARGET_PROOF_INVALID" }
    );
    const result = await execute(
      [standaloneScenario()],
      [],
      {
        verifyReplayTarget: async () => {
          throw targetError;
        }
      }
    );

    expect(result.error).toBe(targetError);
    expect(result.preflightMock).toHaveBeenCalledOnce();
    expect(result.setupMock).not.toHaveBeenCalled();
    expect(result.replayMock).not.toHaveBeenCalled();
    expect(result.writes).toHaveLength(0);
  });

  it("performs no setup when per-scenario target verification fails", async () => {
    const targetError = Object.assign(
      new Error("Replay target changed."),
      { code: "REPLAY_TARGET_ID_MISMATCH" }
    );
    const verify = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(targetError);
    const result = await execute(
      [standaloneScenario()],
      [],
      { verifyReplayTarget: verify }
    );

    expect(result.error).toBe(targetError);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.setupMock).not.toHaveBeenCalled();
    expect(result.replayMock).not.toHaveBeenCalled();
    expect(result.writes).toHaveLength(0);
  });

  it("performs no setup or HTTP request after startup safety refusal", async () => {
    const safetyError = Object.assign(
      new Error("Replay safety check failed."),
      { code: "REPLAY_MARKER_ROW_MISSING" }
    );
    const result = await execute(
      [standaloneScenario()],
      [],
      {
        preflightReplaySafety: async () => {
          throw safetyError;
        }
      }
    );

    expect(result.error).toBe(safetyError);
    expect(result.setupMock).not.toHaveBeenCalled();
    expect(result.replayMock).not.toHaveBeenCalled();
    expect(result.writes).toHaveLength(0);
  });

  it("records an unresolved path reference before HTTP", async () => {
    const result = await execute([
      lifecycleScenario([
        step({
          request: {
            method: "GET",
            path: "/orders/:id",
            body: null,
            pathParams: {
              id: {
                $ref: "missingOrderId"
              }
            }
          }
        })
      ])
    ]);

    expectBindingFailure(
      result.report,
      "UNRESOLVED_BINDING"
    );
    expect(result.replayMock).not.toHaveBeenCalled();
  });

  it("records a missing capture source after the producer request", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            request: {
              method: "POST",
              path: "/orders",
              body: {}
            },
            expected: {
              status: 200,
              body: { orderId: 100 }
            },
            capture: {
              orderId: {
                from: "response.body",
                pointer: "/orderId",
                type: "number"
              }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: {
            status: "ok"
          }
        }
      ]
    );

    expectBindingFailure(
      result.report,
      "CAPTURE_SOURCE_MISSING"
    );
    expect(result.replayMock).toHaveBeenCalledOnce();
  });

  it("records capture type mismatches", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            expected: {
              status: 200,
              body: { orderId: 100 }
            },
            capture: {
              orderId: {
                from: "response.body",
                pointer: "/orderId",
                type: "number"
              }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: {
            orderId: "12"
          }
        }
      ]
    );

    expectBindingFailure(
      result.report,
      "CAPTURE_TYPE_MISMATCH"
    );
    expect(result.replayMock).toHaveBeenCalledOnce();
  });

  it("records duplicate bindings", async () => {
    const capture = {
      orderId: {
        from: "response.body",
        pointer: "/orderId",
        type: "number"
      }
    } satisfies Record<
      string,
      CaptureDefinition
    >;
    const result = await execute(
      [
        lifecycleScenario([
          step({
            expected: {
              status: 200,
              body: {
                orderId: 100
              }
            },
            capture
          }),
          step({
            expected: {
              status: 200,
              body: {
                orderId: 200
              }
            },
            capture
          })
        ])
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        },
        {
          status: 200,
          body: { orderId: 13 }
        }
      ]
    );

    expectBindingFailure(
      result.report,
      "DUPLICATE_BINDING"
    );
    expect(result.report).toMatchObject({
      checks: 2,
      passedChecks: 1,
      failedChecks: 1
    });
    expect(result.replayMock).toHaveBeenCalledOnce();
  });

  it("records unsupported capture sources", async () => {
    const capture = {
      orderId: {
        from: "response.headers",
        pointer: "/orderId",
        type: "number"
      }
    } as unknown as Record<
      string,
      CaptureDefinition
    >;
    const result = await execute(
      [
        lifecycleScenario([
          step({ capture })
        ])
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        }
      ]
    );

    expectBindingFailure(
      result.report,
      "UNSUPPORTED_CAPTURE_SOURCE"
    );
    expect(result.replayMock).not.toHaveBeenCalled();
  });

  it("records invalid JSON Pointers", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            capture: {
              orderId: {
                from: "response.body",
                pointer: "orderId",
                type: "number"
              }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        }
      ]
    );

    expectBindingFailure(
      result.report,
      "INVALID_JSON_POINTER"
    );
    expect(result.replayMock).not.toHaveBeenCalled();
  });

  it("records unresolved expected-body references", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            expected: {
              status: 200,
              body: {
                orderId: {
                  $ref: "missingOrderId"
                }
              }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        }
      ]
    );

    expectBindingFailure(
      result.report,
      "UNRESOLVED_BINDING"
    );
    expect(result.replayMock).not.toHaveBeenCalled();
  });

  it("executes a same-step capture used by the expected body", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            expected: {
              status: 200,
              body: {
                orderId: { $ref: "orderId" }
              }
            },
            capture: {
              orderId: {
                from: "response.body",
                pointer: "/orderId",
                type: "number"
              }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.replayMock).toHaveBeenCalledOnce();
    expect(result.report).toMatchObject({
      passed: true,
      checks: 1,
      passedChecks: 1,
      failedChecks: 0
    });
  });

  it("executes refs captured by a previous step", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            expected: {
              status: 200,
              body: { orderId: 100 }
            },
            capture: {
              orderId: {
                from: "response.body",
                pointer: "/orderId",
                type: "number"
              }
            }
          }),
          step({
            request: {
              method: "GET",
              path: "/orders/:id",
              body: null,
              pathParams: {
                id: { $ref: "orderId" }
              }
            },
            expected: {
              status: 200,
              body: {
                orderId: { $ref: "orderId" }
              }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        },
        {
          status: 200,
          body: { orderId: 12 }
        }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.replayMock).toHaveBeenCalledTimes(2);
    expect(result.replayMock).toHaveBeenLastCalledWith(
      "GET",
      "/orders/:id",
      null,
      { id: "12" },
      {}
    );
    expect(result.report).toMatchObject({
      passed: true,
      checks: 2,
      passedChecks: 2,
      failedChecks: 0
    });
  });

  it("records invalid path parameter values", async () => {
    const result = await execute([
      lifecycleScenario([
        step({
          request: {
            method: "GET",
            path: "/orders/:id",
            body: null,
            pathParams: {
              id: {
                $ref: "not-a-reference",
                extra: true
              } as unknown as {
                $ref: string;
              }
            }
          }
        })
      ])
    ]);

    expectBindingFailure(
      result.report,
      "INVALID_PATH_PARAMETER_VALUE"
    );
    expect(result.replayMock).not.toHaveBeenCalled();
  });

  it("skips later lifecycle steps and continues with a fresh scenario setup", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            request: {
              method: "GET",
              path: "/orders/:id",
              body: null,
              pathParams: {
                id: { $ref: "missing" }
              }
            }
          }),
          step({
            request: {
              method: "GET",
              path: "/must-not-run",
              body: null
            }
          })
        ]),
        standaloneScenario(2)
      ],
      [
        {
          status: 200,
          body: { status: "ok" }
        }
      ]
    );

    expect(result.replayMock).toHaveBeenCalledOnce();
    expect(result.replayMock).toHaveBeenCalledWith(
      "GET",
      "/standalone",
      null,
      {},
      {}
    );
    expect(result.setupMock).toHaveBeenCalledTimes(2);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].path).toBe(
      "shadowspec-report.json"
    );
    expect(result.report).toMatchObject({
      scenarios: 2,
      checks: 2,
      passedChecks: 1,
      failedChecks: 1
    });
    expect(result.error).toEqual(
      new Error(
        "ShadowSpec detected 1 regression(s)."
      )
    );
    expect(
      result.logs.flat().some(
        (value) =>
          typeof value === "string" &&
          value.includes(
            "Binding UNRESOLVED_BINDING"
          )
      )
    ).toBe(true);
  });

  it("does not leak bindings into a later scenario", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            expected: {
              status: 200,
              body: { orderId: 100 }
            },
            capture: {
              orderId: {
                from: "response.body",
                pointer: "/orderId",
                type: "number"
              }
            }
          })
        ]),
        lifecycleScenario(
          [
            step({
              request: {
                method: "GET",
                path: "/orders/:id",
                body: null,
                pathParams: {
                  id: { $ref: "orderId" }
                }
              }
            })
          ],
          2
        )
      ],
      [
        {
          status: 200,
          body: { orderId: 12 }
        }
      ]
    );

    expect(result.replayMock).toHaveBeenCalledOnce();
    expect(result.report).toMatchObject({
      checks: 2,
      passedChecks: 1,
      failedChecks: 1
    });
    expectBindingFailure(
      result.report,
      "UNRESOLVED_BINDING"
    );
  });

  it("keeps behavioral mismatches as differences and continues", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step(),
          step({
            request: {
              method: "GET",
              path: "/second",
              body: null
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: { status: "wrong" }
        },
        {
          status: 200,
          body: { status: "ok" }
        }
      ]
    );

    expect(result.replayMock).toHaveBeenCalledTimes(2);
    expect(result.report).toMatchObject({
      checks: 2,
      passedChecks: 1,
      failedChecks: 1
    });
    expect(result.report?.failures[0].kind)
      .toBeUndefined();
    expect(
      result.report?.failures[0].differences
    ).not.toHaveLength(0);
  });

  it("leaves legacy lifecycle requests unchanged", async () => {
    const result = await execute(
      [
        lifecycleScenario([
          step({
            request: {
              method: "GET",
              path: "/orders/:id",
              body: null,
              pathParams: { id: "3" }
            }
          })
        ])
      ],
      [
        {
          status: 200,
          body: { status: "ok" }
        }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.report?.passed).toBe(true);
    expect(result.replayMock).toHaveBeenCalledWith(
      "GET",
      "/orders/:id",
      null,
      { id: "3" },
      {}
    );
  });

  it("leaves standalone replay unchanged", async () => {
    const result = await execute(
      [standaloneScenario()],
      [
        {
          status: 200,
          body: { status: "ok" }
        }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.report).toMatchObject({
      passed: true,
      checks: 1,
      passedChecks: 1,
      failedChecks: 0,
      failures: []
    });
  });

  it("keeps network errors fatal", async () => {
    const networkError = new Error(
      "network unavailable"
    );
    const result = await execute(
      [lifecycleScenario([step()])],
      [],
      {
        replayRequest: async () => {
          throw networkError;
        }
      }
    );

    expect(result.error).toBe(networkError);
    expect(result.writes).toHaveLength(0);
  });

  it("keeps database setup errors fatal", async () => {
    const databaseError = new Error(
      "database unavailable"
    );
    const result = await execute(
      [standaloneScenario()],
      [],
      {
        applyReplaySetup: async () => {
          throw databaseError;
        }
      }
    );

    expect(result.error).toBe(databaseError);
    expect(result.replayMock).not.toHaveBeenCalled();
    expect(result.writes).toHaveLength(0);
  });

  it("keeps unexpected errors fatal", async () => {
    const unexpectedError = new Error(
      "unexpected"
    );
    const result = await execute(
      [],
      [],
      {
        loadScenarios: () => {
          throw unexpectedError;
        }
      }
    );

    expect(result.error).toBe(unexpectedError);
    expect(result.writes).toHaveLength(0);
  });

  it.each([
    ["status"],
    ["/status"]
  ])("rejects nonempty legacy dynamicFields before setup or scenario HTTP", async (dynamicFields) => {
    const scenario = {
      ...standaloneScenario(),
      dynamicFields
    };
    const result = await execute([scenario]);

    expect(result.error).toMatchObject({
      code: "UNSAFE_LEGACY_DYNAMIC_FIELD"
    });
    expect(result.setupMock).not.toHaveBeenCalled();
    expect(result.replayMock).not.toHaveBeenCalled();
    expect(
      result.targetVerificationMock
    ).not.toHaveBeenCalled();
  });

  it("allows empty legacy dynamicFields without masking behavior", async () => {
    const scenario = {
      ...standaloneScenario(),
      dynamicFields: []
    };
    const result = await execute(
      [scenario],
      [{ status: 200, body: { status: "changed" } }]
    );

    expect(result.report).toMatchObject({
      passed: false,
      failedChecks: 1
    });
  });

  it("uses exact explicit ignored-value comparison during replay", async () => {
    const scenario = {
      ...standaloneScenario(),
      expected: {
        status: 200,
        body: {
          requestId: "production",
          status: "ok"
        }
      },
      comparison: {
        ignoredValues: [
          {
            pointer: "/requestId",
            type: "string" as const
          }
        ]
      }
    };
    const result = await execute(
      [scenario],
      [
        {
          status: 200,
          body: {
            requestId: "replay",
            status: "ok"
          }
        }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.report).toMatchObject({
      passed: true,
      passedChecks: 1,
      failedChecks: 0
    });
  });
});
