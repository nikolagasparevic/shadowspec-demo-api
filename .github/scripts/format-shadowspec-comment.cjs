const MARKER = "<!-- shadowspec-report -->";
const {
  validateRunResult
} = require("./run-result.cjs");
const MAX_DIFFERENCES = 10;
const MAX_VALUE_LENGTH = 160;
const MISSING = Symbol("missing");

function inlineCode(value) {
  const text = String(value).replace(
    /[\r\n]+/g,
    " "
  );
  const runs = text.match(/`+/g) ?? [];
  const fenceLength = Math.max(
    1,
    ...runs.map((run) => run.length + 1)
  );
  const fence = "`".repeat(fenceLength);

  return `${fence}${text}${fence}`;
}

function escapeMarkdownText(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}\[\]()#+\-!|<>])/g, "\\$1");
}

function serializeValue(value) {
  if (value === MISSING) {
    return "missing";
  }

  let serialized;

  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  if (serialized === undefined) {
    serialized = String(value);
  }

  if (serialized.length > MAX_VALUE_LENGTH) {
    serialized = `${serialized.slice(
      0,
      MAX_VALUE_LENGTH - 1
    )}…`;
  }

  return inlineCode(serialized);
}

function valuesEqual(expected, actual) {
  return (
    expected === actual ||
    JSON.stringify(expected) ===
      JSON.stringify(actual)
  );
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function objectPath(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(
    key
  )
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function collectValueDifferences(
  expected,
  actual,
  path,
  differences
) {
  if (valuesEqual(expected, actual)) {
    return;
  }

  if (
    Array.isArray(expected) &&
    Array.isArray(actual)
  ) {
    const length = Math.max(
      expected.length,
      actual.length
    );

    for (let index = 0; index < length; index++) {
      collectValueDifferences(
        index < expected.length
          ? expected[index]
          : MISSING,
        index < actual.length
          ? actual[index]
          : MISSING,
        `${path}[${index}]`,
        differences
      );
    }

    return;
  }

  if (isObject(expected) && isObject(actual)) {
    const keys = Array.from(
      new Set([
        ...Object.keys(expected),
        ...Object.keys(actual)
      ])
    ).sort();

    for (const key of keys) {
      collectValueDifferences(
        Object.prototype.hasOwnProperty.call(
          expected,
          key
        )
          ? expected[key]
          : MISSING,
        Object.prototype.hasOwnProperty.call(
          actual,
          key
        )
          ? actual[key]
          : MISSING,
        objectPath(path, key),
        differences
      );
    }

    return;
  }

  differences.push({
    path,
    expected,
    actual
  });
}

function getBehavioralDifferences(failure) {
  const differences = [];

  for (const difference of failure.differences ?? []) {
    if (difference.field === "body") {
      const before = differences.length;

      collectValueDifferences(
        difference.expected,
        difference.actual,
        "body",
        differences
      );

      if (differences.length === before) {
        differences.push({
          path: "body",
          expected: difference.expected,
          actual: difference.actual
        });
      }

      continue;
    }

    differences.push({
      path: difference.field,
      expected: difference.expected,
      actual: difference.actual
    });
  }

  return differences;
}

function formatRequest(failure) {
  const queryKeys = Object.keys(
    failure.queryParams ?? {}
  );
  const query = queryKeys.length > 0
    ? `?${queryKeys
        .map(
          (key) =>
            `${encodeURIComponent(key)}=…`
        )
        .join("&")}`
    : "";

  return inlineCode(
    `${failure.method} ${failure.path}${query}`
  );
}

function formatFailure(failure) {
  const step = failure.step === undefined
    ? ""
    : ` / Step ${failure.step}`;
  const lines = [
    `### Scenario ${failure.scenario}${step}`,
    "",
    formatRequest(failure),
    ""
  ];

  if (failure.kind === "binding") {
    const code = failure.code
      ? ` — ${inlineCode(failure.code)}`
      : "";

    lines.push(
      `**Binding failure${code}**`,
      "",
      `- ${escapeMarkdownText(
        failure.message ??
          "Lifecycle binding failed."
      )}`
    );

    return lines.join("\n");
  }

  lines.push(
    "**Behavioral regression**",
    ""
  );

  const differences =
    getBehavioralDifferences(failure);
  const shown = differences.slice(
    0,
    MAX_DIFFERENCES
  );

  for (const difference of shown) {
    lines.push(
      `- ${inlineCode(difference.path)}: expected ${serializeValue(
        difference.expected
      )}, received ${serializeValue(
        difference.actual
      )}`
    );
  }

  if (differences.length > shown.length) {
    const omitted =
      differences.length - shown.length;

    lines.push(
      `- _${omitted} additional difference${
        omitted === 1 ? "" : "s"
      } omitted; see the report artifact._`
    );
  }

  if (shown.length === 0) {
    lines.push(
      "- _No structured differences were provided; see the report artifact._"
    );
  }

  return lines.join("\n");
}

function correlationLines(result) {
  const shortCommit = result.commitSha.slice(0, 7);
  const displayRun = result.workflowRunId ?? result.runId;
  return [
    `<!-- shadowspec-run id=${result.runId} head=${result.sourceHeadSha ?? result.commitSha} workflow-run=${result.workflowRunId ?? "local"} attempt=${result.runAttempt} -->`,
    "",
    `Commit ${inlineCode(shortCommit)} · Run ${inlineCode(displayRun)} · Attempt ${inlineCode(result.runAttempt)}`
  ];
}

function fatalLabel(result) {
  const labels = {
    safety: "Replay safety failure",
    configuration: "Configuration failure",
    infrastructure: "Infrastructure failure",
    internal: "Internal failure"
  };
  return labels[result.fatalError.category] ?? "ShadowSpec failure";
}

function formatRunningComment(identity) {
  const shortCommit = identity.commitSha.slice(0, 7);
  const displayRun = identity.workflowRunId ?? identity.runId;
  return [
    MARKER,
    `<!-- shadowspec-run id=${identity.runId} head=${identity.sourceHeadSha ?? identity.commitSha} workflow-run=${identity.workflowRunId ?? "local"} attempt=${identity.runAttempt} -->`,
    "",
    "## 🟡 ShadowSpec is running",
    "",
    `Commit ${inlineCode(shortCommit)} · Run ${inlineCode(displayRun)} · Attempt ${inlineCode(identity.runAttempt)}`,
    "",
    "---",
    "_ShadowSpec behavioral regression check_"
  ].join("\n");
}

function formatShadowSpecComment(value, expectedIdentity) {
  const report = validateRunResult(value, expectedIdentity);
  const correlation = correlationLines(report);

  if (report.terminalStatus === "passed") {
    return [
      MARKER,
      correlation[0],
      "## 🟢 ShadowSpec passed",
      "",
      ...correlation.slice(1),
      "",
      `**${report.passedChecks} of ${report.checks} checks passed** across **${report.scenarios} scenarios**.`,
      "",
      "No behavioral regressions detected.",
      "",
      "---",
      "_ShadowSpec behavioral regression check_"
    ].join("\n");
  }

  if (report.terminalStatus !== "behavioral_failed") {
    const completed = report.plannedChecks > 0
      ? `${report.checks} of ${report.plannedChecks} planned checks completed.`
      : "No behavioral checks completed.";
    return [
      MARKER,
      correlation[0],
      "## 🔴 ShadowSpec could not complete",
      "",
      ...correlation.slice(1),
      "",
      `**${fatalLabel(report)} — ${inlineCode(report.fatalError.code)}**`,
      "",
      escapeMarkdownText(report.fatalError.message),
      "",
      completed,
      "",
      "---",
      "_ShadowSpec behavioral regression check_"
    ].join("\n");
  }

  const lines = [
    MARKER,
    correlation[0],
    `## 🔴 ShadowSpec failed — ${report.failedChecks} of ${report.checks} checks failed`,
    "",
    ...correlation.slice(1),
    "",
    `**${report.passedChecks} passed · ${report.failedChecks} failed · ${report.scenarios} scenarios**`
  ];

  for (const failure of report.failures ?? []) {
    lines.push("", formatFailure(failure));
  }

  lines.push(
    "",
    "---",
    "_ShadowSpec behavioral regression check_"
  );

  return lines.join("\n");
}

module.exports = {
  formatRunningComment,
  formatShadowSpecComment
};
