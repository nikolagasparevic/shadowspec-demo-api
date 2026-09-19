import {
  describe,
  expect,
  it
} from "vitest";
import type {
  ShadowSpecReport
} from "../src/report";
import type {
  ShadowSpecRunResult
} from "../src/run-result";

const {
  formatRunningComment,
  formatShadowSpecComment
}: {
  formatRunningComment: (
    identity: Pick<
      ShadowSpecRunResult,
      | "runId"
      | "commitSha"
      | "sourceHeadSha"
      | "workflowRunId"
      | "runAttempt"
    >
  ) => string;
  formatShadowSpecComment: (
    report: ShadowSpecRunResult,
    expectedIdentity?: Record<string, unknown>
  ) => string;
} = require(
  "../.github/scripts/format-shadowspec-comment.cjs"
);

function behavioralFailure(
  overrides: Partial<
    ShadowSpecReport["failures"][number]
  > = {}
): ShadowSpecReport["failures"][number] {
  return {
    scenario: 1,
    method: "GET",
    path: "/orders/2",
    queryParams: {},
    differences: [
      {
        field: "body",
        expected: { productId: 9999 },
        actual: { productId: 12345 }
      }
    ],
    ...overrides
  };
}

function runResult(
  overrides: Partial<ShadowSpecRunResult> = {}
): ShadowSpecRunResult {
  const executableCaptures = overrides.plannedChecks ?? 1;
  return {
    version: 2,
    reportSource: "shadowspec-replay",
    reportVersion: 2,
    runId: "123.1.replay",
    repository: "example/shadowspec",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    workflowRunId: "123",
    runAttempt: 1,
    exportId: "a".repeat(64),
    coverage: {
      inputCaptures: executableCaptures,
      executableCaptures,
      rejectedCaptures: 0,
      excludedCaptures: 0,
      complete: true
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    terminalStatus: "passed",
    scenarios: 1,
    scenariosCompleted: 1,
    plannedChecks: 1,
    checks: 1,
    passedChecks: 1,
    failedChecks: 0,
    behavioralFailures: 0,
    failures: [],
    fatalError: null,
    ...overrides
  };
}

function failedReport(
  failures: ShadowSpecReport["failures"]
): ShadowSpecRunResult {
  return runResult({
    terminalStatus: "behavioral_failed",
    scenarios: failures.length,
    scenariosCompleted: failures.length,
    plannedChecks: failures.length,
    checks: failures.length,
    passedChecks: 0,
    failedChecks: failures.length,
    behavioralFailures: failures.length,
    failures
  });
}

describe("formatShadowSpecComment", () => {
  it("formats a correlated in-progress comment", () => {
    const result = runResult();
    const comment = formatRunningComment(result);
    expect(comment).toContain("ShadowSpec is running");
    expect(comment).toContain("id=123.1.replay");
    expect(comment).toContain("Commit `aaaaaaa`");
  });

  it("formats a successful report", () => {
    const comment = formatShadowSpecComment(runResult({
      scenarios: 7,
      scenariosCompleted: 7,
      plannedChecks: 8,
      checks: 8,
      passedChecks: 8,
      failedChecks: 0,
      failures: []
    }));

    expect(comment).toContain(
      "## 🟢 ShadowSpec passed"
    );
    expect(comment).toContain(
      "**8 of 8 checks passed** across **7 scenarios**."
    );
    expect(comment).toContain(
      "No behavioral regressions detected."
    );
  });

  it("formats a standalone behavioral failure", () => {
    const comment = formatShadowSpecComment(
      failedReport([behavioralFailure()])
    );

    expect(comment).toContain("### Scenario 1");
    expect(comment).not.toContain(
      "Scenario 1 / Step"
    );
    expect(comment).toContain(
      "`GET /orders/2`"
    );
    expect(comment).toContain(
      "**Behavioral regression**"
    );
  });

  it("formats a lifecycle failure with its step", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          scenario: 3,
          step: 2
        })
      ])
    );

    expect(comment).toContain(
      "### Scenario 3 / Step 2"
    );
  });

  it("formats a binding failure with code and message", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          step: 2,
          kind: "binding",
          code: "UNRESOLVED_BINDING",
          message:
            'Unresolved ShadowSpec binding: "orderId".',
          differences: []
        })
      ])
    );

    expect(comment).toContain(
      "**Binding failure — `UNRESOLVED_BINDING`**"
    );
    expect(comment).toContain(
      'Unresolved ShadowSpec binding: "orderId".'
    );
  });

  it("represents binding-only reports as failures", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          kind: "binding",
          code: "DUPLICATE_BINDING",
          message: "Binding already exists.",
          differences: []
        })
      ])
    );

    expect(comment).toContain(
      "ShadowSpec failed — 1 of 1 checks failed"
    );
    expect(comment).not.toContain(
      "0 behavioral regressions"
    );
  });

  it("formats mixed behavioral and binding failures", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure(),
        behavioralFailure({
          scenario: 2,
          step: 3,
          kind: "binding",
          code: "CAPTURE_SOURCE_MISSING",
          message: "Capture source was missing.",
          differences: []
        })
      ])
    );

    expect(comment).toContain(
      "**Behavioral regression**"
    );
    expect(comment).toContain(
      "**Binding failure — `CAPTURE_SOURCE_MISSING`**"
    );
  });

  it("formats HTTP status differences", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "httpStatus",
              expected: 200,
              actual: 500
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `httpStatus`: expected `200`, received `500`"
    );
  });

  it("formats nested body scalar differences", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: {
                order: { productId: 9999 }
              },
              actual: {
                order: { productId: 12345 }
              }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.order.productId`: expected `9999`, received `12345`"
    );
  });

  it("formats added fields", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: {},
              actual: { added: true }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.added`: expected missing, received `true`"
    );
  });

  it("formats removed fields", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { removed: true },
              actual: {}
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.removed`: expected `true`, received missing"
    );
  });

  it("formats simple array index differences", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { items: [1, 2] },
              actual: { items: [1, 3] }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.items[1]`: expected `2`, received `3`"
    );
  });

  it("truncates long displayed values", () => {
    const longValue = "x".repeat(300);
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { value: "short" },
              actual: { value: longValue }
            }
          ]
        })
      ])
    );

    expect(comment).toContain("…");
    expect(comment).not.toContain(longValue);
  });

  it("limits displayed differences", () => {
    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};

    for (let index = 0; index < 12; index++) {
      expected[`field${index}`] = index;
      actual[`field${index}`] = index + 100;
    }

    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected,
              actual
            }
          ]
        })
      ])
    );

    expect(
      comment.match(/^- `body\.field/gm)
    ).toHaveLength(10);
    expect(comment).toContain(
      "2 additional differences omitted"
    );
  });

  it("hides raw query parameter values", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          path: "/search",
          queryParams: {
            status: "private-status",
            token: "secret-token"
          }
        })
      ])
    );

    expect(comment).toContain(
      "`GET /search?status=…&token=…`"
    );
    expect(comment).not.toContain(
      "private-status"
    );
    expect(comment).not.toContain(
      "secret-token"
    );
  });

  it("contains Markdown-sensitive values inside safe code spans", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { value: "plain" },
              actual: {
                value:
                  "**bold** `code`\n# heading"
              }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      '``"**bold** `code`\\n# heading"``'
    );
    expect(comment).not.toContain(
      "\n# heading\n"
    );
  });

  it("rejects legacy behavioral failure reports", () => {
    const failure = behavioralFailure();
    delete failure.kind;
    delete failure.code;
    delete failure.message;

    const legacy = {
      passed: false,
      scenarios: 1,
      checks: 1,
      passedChecks: 0,
      failedChecks: 1,
      failures: [failure]
    };

    expect(() => formatShadowSpecComment(
      legacy as unknown as ShadowSpecRunResult
    )).toThrow("unsupported fields");
  });

  it.each([
    ["safety_failed", "safety", "Replay safety failure"],
    ["configuration_failed", "configuration", "Configuration failure"],
    ["infrastructure_failed", "infrastructure", "Infrastructure failure"],
    ["internal_failed", "internal", "Internal failure"],
    ["interrupted", "infrastructure", "Infrastructure failure"]
  ] as const)("formats %s without behavioral-green wording", (
    terminalStatus,
    category,
    label
  ) => {
    const comment = formatShadowSpecComment(runResult({
      terminalStatus,
      scenarios: 3,
      scenariosCompleted: 2,
      plannedChecks: 8,
      checks: 5,
      passedChecks: 5,
      fatalError: {
        category,
        code: "SAFE_FAILURE",
        message: "Safe diagnostic."
      }
    }));
    expect(comment).toContain("ShadowSpec could not complete");
    expect(comment).toContain(label);
    expect(comment).toContain("5 of 8 planned checks completed");
    expect(comment).not.toContain("No behavioral regressions detected");
  });

  it("rejects unsupported versions and identity mismatches", () => {
    expect(() => formatShadowSpecComment(runResult({
      version: 1 as 2
    }))).toThrow("version, source, or terminal status");
    expect(() => formatShadowSpecComment(
      runResult(),
      {
        runId: "different",
        repository: "example/shadowspec",
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        workflowRunId: "123",
        runAttempt: 1
      }
    )).toThrow("different execution");
  });

  it("does not expose unrelated sensitive data in fatal output", () => {
    const result = runResult({
      terminalStatus: "internal_failed",
      checks: 0,
      passedChecks: 0,
      scenariosCompleted: 0,
      fatalError: {
        category: "internal",
        code: "UNEXPECTED_INTERNAL_ERROR",
        message: "ShadowSpec encountered an unexpected internal error."
      }
    }) as ShadowSpecRunResult & { secret?: string };
    result.secret = "super-secret-token";
    expect(() => formatShadowSpecComment(result))
      .toThrow("unsupported fields");
  });

  it("preserves the ShadowSpec marker", () => {
    const comment = formatShadowSpecComment(runResult({
      scenarios: 1,
      checks: 1,
      passedChecks: 1,
      failedChecks: 0,
      failures: []
    }));

    expect(comment.startsWith(
      "<!-- shadowspec-report -->\n"
    )).toBe(true);
  });
});
