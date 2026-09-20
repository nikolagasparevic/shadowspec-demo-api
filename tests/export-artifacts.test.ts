import fs from "fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  exportScenarios,
  ScenarioArtifactError,
  ScenarioExportError
} from "../src/export-scenarios";
import { runReplay } from "../src/run-replay";
import type { FrozenCaptureSet } from "../src/export-captures";

const temporaryDirectories: string[] = [];

function temporaryPaths() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowspec-export-")
  );
  temporaryDirectories.push(directory);

  return {
    directory,
    scenarioPath: path.join(
      directory,
      "shadowspec-scenarios.json"
    ),
    candidatePath: path.join(
      directory,
      "shadowspec-candidates.json"
    ),
    diagnosticPath: path.join(
      directory,
      "shadowspec-export-result.json"
    )
  };
}

function validCaptures(): FrozenCaptureSet {
  return {
    maxVisibleCaptureId: 1,
    captures: [{
      id: 1,
      active: true,
      sessionId: null,
      method: "GET",
      path: "/health",
      pathParams: {},
      queryParams: {},
      requestBody: null,
      responseStatus: 200,
      responseBody: { status: "ok" },
      snapshots: [{
        tables: { resources: { rows: [] } }
      }]
    }]
  };
}

function sensitiveCaptures(): FrozenCaptureSet {
  const frozen = validCaptures();
  frozen.captures[0].path = "/profile";
  frozen.captures[0].responseBody = { token: "secret" };
  return frozen;
}

async function runExport(
  scenarioPath: string,
  candidatePath: string,
  frozen: FrozenCaptureSet = validCaptures()
) {
  await exportScenarios({
    scenarioPath,
    candidatePath,
    diagnosticPath: path.join(path.dirname(scenarioPath), "shadowspec-export-result.json"),
    projectId: "test-project",
    loadFrozenCaptureSet: async () => frozen,
    log: () => undefined
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true
    });
  }
});

describe("scenario export artifact publication", () => {
  it("replaces an existing executable artifact with a complete successful export", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(
      paths.scenarioPath,
      JSON.stringify([{ id: "old-green" }])
    );

    await runExport(
      paths.scenarioPath,
      paths.candidatePath
    );

    expect(
      JSON.parse(
        fs.readFileSync(paths.scenarioPath, "utf8")
      )
    ).toMatchObject({
      version: 2,
      kind: "shadowspec-scenario-bundle",
      scenarios: [{
        id: 1,
        request: { path: "/health" },
        expected: { body: { status: "ok" } }
      }]
    });
  });

  it("invalidates an old artifact when sanitized response export fails", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(paths.scenarioPath, "old green");

    await expect(
      runExport(
        paths.scenarioPath,
        paths.candidatePath,
        sensitiveCaptures()
      )
    ).rejects.toMatchObject<Partial<ScenarioExportError>>({
      code: "EXPORT_COVERAGE_INCOMPLETE"
    });
    expect(fs.existsSync(paths.scenarioPath)).toBe(false);
    const diagnostic = fs.readFileSync(paths.diagnosticPath, "utf8");
    expect(diagnostic).toContain("REJECTED_SANITIZATION");
    expect(diagnostic).not.toContain("secret");
  });

  it("invalidates an old artifact on arbitrary construction failure", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(paths.scenarioPath, "old green");

    await expect(
      exportScenarios({
        scenarioPath: paths.scenarioPath,
        candidatePath: paths.candidatePath,
        projectId: "test-project",
        loadFrozenCaptureSet: async () => {
          throw new Error("construction failed");
        },
        log: () => undefined
      })
    ).rejects.toThrow("construction failed");
    expect(fs.existsSync(paths.scenarioPath)).toBe(false);
  });

  it("publishes an explicit empty artifact for a zero-scenario export", async () => {
    const paths = temporaryPaths();
    const log = vi.fn();
    fs.writeFileSync(paths.scenarioPath, "old green");

    await exportScenarios({
      scenarioPath: paths.scenarioPath,
      candidatePath: paths.candidatePath,
      diagnosticPath: paths.diagnosticPath,
      projectId: "test-project",
      loadFrozenCaptureSet: async () => ({
        maxVisibleCaptureId: null,
        captures: []
      }),
      log
    });

    expect(
      JSON.parse(fs.readFileSync(paths.scenarioPath, "utf8"))
    ).toMatchObject({
      version: 2,
      coverage: {
        complete: true,
        executableCaptures: 0,
        checkCount: 0
      },
      scenarios: []
    });
    expect(log).toHaveBeenCalledWith("No scenarios found.");
  });

  it("does not create an executable artifact when export fails without an old file", async () => {
    const paths = temporaryPaths();

    await expect(
      runExport(
        paths.scenarioPath,
        paths.candidatePath,
        sensitiveCaptures()
      )
    ).rejects.toBeInstanceOf(ScenarioExportError);
    expect(fs.existsSync(paths.scenarioPath)).toBe(false);
  });

  it("leaves no final or temporary executable artifact when atomic publication fails", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(paths.scenarioPath, "old green");
    const fileSystem = {
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      unlinkSync: fs.unlinkSync,
      renameSync: (
        source: fs.PathLike,
        destination: fs.PathLike
      ) => {
        if (
          String(destination) === paths.scenarioPath
        ) {
          throw new Error("rename failed");
        }
        fs.renameSync(source, destination);
      }
    };

    await expect(
      exportScenarios({
        scenarioPath: paths.scenarioPath,
        candidatePath: paths.candidatePath,
        fileSystem,
        projectId: "test-project",
        loadFrozenCaptureSet: async () => validCaptures(),
        log: () => undefined
      })
    ).rejects.toMatchObject<Partial<ScenarioArtifactError>>({
      code: "ARTIFACT_WRITE_FAILED"
    });

    expect(fs.existsSync(paths.scenarioPath)).toBe(false);
    expect(
      fs.readdirSync(paths.directory).filter(
        (name) => name.endsWith(".tmp")
      )
    ).toEqual([]);
  });

  it("cannot replay an old green artifact after failed export", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(
      paths.scenarioPath,
      JSON.stringify([{ id: "old-green" }])
    );

    await expect(
      runExport(
        paths.scenarioPath,
        paths.candidatePath,
        sensitiveCaptures()
      )
    ).rejects.toBeInstanceOf(ScenarioExportError);

    const request = vi.fn();
    await expect(
      runReplay({
        preflightReplaySafety: async () => undefined,
        loadScenarios: () => JSON.parse(
          fs.readFileSync(paths.scenarioPath, "utf8")
        ),
        verifyReplayTarget: async () => undefined,
        applyReplaySetup: async () => undefined,
        replayRequest: request,
        invalidateReportFile: () => undefined,
        writeReportFile: () => undefined,
        log: () => undefined
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(request).not.toHaveBeenCalled();
  });

  it("cannot replay previous scenarios after a zero-scenario export", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(
      paths.scenarioPath,
      JSON.stringify([{ id: "old-green" }])
    );
    await runExport(
      paths.scenarioPath,
      paths.candidatePath,
      { maxVisibleCaptureId: null, captures: [] }
    );
    const request = vi.fn();

    await expect(runReplay({
      preflightReplaySafety: async () => undefined,
      loadScenarios: () => JSON.parse(
        fs.readFileSync(paths.scenarioPath, "utf8")
      ),
      verifyReplayTarget: async () => undefined,
      applyReplaySetup: async () => undefined,
      replayRequest: request,
      invalidateReportFile: () => undefined,
      writeReportFile: () => undefined,
      log: () => undefined
    })).rejects.toThrow(
      "ShadowSpec found no executable behavioral checks."
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("replays a newly published successful export normally", async () => {
    const paths = temporaryPaths();
    await runExport(
      paths.scenarioPath,
      paths.candidatePath
    );
    const request = vi.fn(async () => ({
      status: 200,
      body: { status: "ok" }
    }));
    const reportWrites: string[] = [];

    await runReplay({
      preflightReplaySafety: async () => undefined,
      loadScenarios: () => JSON.parse(
        fs.readFileSync(paths.scenarioPath, "utf8")
      ),
      verifyReplayTarget: async () => undefined,
      applyReplaySetup: async () => undefined,
      replayRequest: request,
      invalidateReportFile: () => undefined,
      writeReportFile: (_path, contents) => {
        reportWrites.push(contents);
      },
      log: () => undefined
    });

    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(reportWrites[0])).toMatchObject({
      version: 2,
      exportId: expect.stringMatching(/^[0-9a-f]{64}$/),
      coverage: {
        complete: true,
        executableCaptures: 1
      },
      checks: 1,
      passedChecks: 1,
      failedChecks: 0
    });
  });

  it("does not read candidate diagnostics when replaying", async () => {
    const paths = temporaryPaths();
    await runExport(paths.scenarioPath, paths.candidatePath);
    fs.writeFileSync(paths.candidatePath, "not valid JSON and not authoritative");
    const request = vi.fn(async () => ({
      status: 200,
      body: { status: "ok" }
    }));

    await runReplay({
      preflightReplaySafety: async () => undefined,
      loadScenarios: () => JSON.parse(fs.readFileSync(paths.scenarioPath, "utf8")),
      verifyReplayTarget: async () => undefined,
      applyReplaySetup: async () => undefined,
      replayRequest: request,
      invalidateReportFile: () => undefined,
      writeReportFile: () => undefined,
      log: () => undefined
    });

    expect(request).toHaveBeenCalledOnce();
  });
});
