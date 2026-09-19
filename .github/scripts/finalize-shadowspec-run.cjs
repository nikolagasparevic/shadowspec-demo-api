const fs = require("node:fs");
const {
  RunResultValidationError,
  expectedIdentityFromEnvironment,
  failureResult,
  getRunResultPath,
  validateRunResult,
  writeJsonAtomically
} = require("./run-result.cjs");

function appendOutput(name, value, environment = process.env) {
  if (environment.GITHUB_OUTPUT) {
    fs.appendFileSync(environment.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function finalizeShadowSpecRun(options = {}) {
  const environment = options.environment ?? process.env;
  const fileSystem = options.fileSystem ?? fs;
  const identity = expectedIdentityFromEnvironment(environment);
  const resultPath = getRunResultPath(
    identity,
    environment.SHADOWSPEC_RESULTS_DIRECTORY || "shadowspec-results"
  );
  let result;
  let validatedRunnerResult = false;

  if (environment.SHADOWSPEC_PREREQUISITE_FAILED === "true") {
    result = failureResult(
      identity,
      "WORKFLOW_PREREQUISITE_FAILED",
      "ShadowSpec workflow preparation failed before replay could complete."
    );
    writeJsonAtomically(resultPath, result, fileSystem);
  } else if (!fileSystem.existsSync(resultPath)) {
    result = failureResult(
      identity,
      "RUN_RESULT_MISSING",
      "ShadowSpec did not produce a result for the current run."
    );
    writeJsonAtomically(resultPath, result, fileSystem);
  } else {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(resultPath, "utf8"));
      result = validateRunResult(parsed, identity);
      validatedRunnerResult = true;
    } catch (error) {
      const code = error instanceof RunResultValidationError
        ? error.code
        : "RUN_RESULT_INVALID";
      result = failureResult(
        identity,
        code,
        code === "RUN_RESULT_IDENTITY_MISMATCH"
          ? "ShadowSpec produced a result for a different run identity."
          : "ShadowSpec produced a malformed or unsupported run result."
      );
      writeJsonAtomically(resultPath, result, fileSystem);
    }
  }

  const replayExitCode = environment.SHADOWSPEC_REPLAY_EXIT_CODE;
  if (
    validatedRunnerResult &&
    replayExitCode !== undefined &&
    ((replayExitCode === "0") !== (result.terminalStatus === "passed"))
  ) {
    result = failureResult(
      identity,
      "RUN_RESULT_INVALID",
      "ShadowSpec replay exit status disagreed with its run result."
    );
    writeJsonAtomically(resultPath, result, fileSystem);
  }

  appendOutput("result_path", resultPath, environment);
  appendOutput("terminal_status", result.terminalStatus, environment);
  return { resultPath, result };
}

if (require.main === module) {
  try {
    const finalized = finalizeShadowSpecRun();
    console.log(
      `ShadowSpec finalized ${finalized.result.terminalStatus} result at ${finalized.resultPath}.`
    );
  } catch (error) {
    console.error("ShadowSpec could not finalize the current run result.");
    process.exitCode = 1;
  }
}

module.exports = { finalizeShadowSpecRun };
