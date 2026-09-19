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
    )
  };
}

function validGroups() {
  return [
    {
      id: 1,
      method: "GET",
      path: "/health",
      pathParams: {},
      queryParams: {},
      requestBody: null,
      responses: [
        {
          status: 200,
          body: { status: "ok" }
        }
      ]
    }
  ];
}

function sensitiveGroups() {
  return [
    {
      id: 1,
      method: "GET",
      path: "/profile",
      pathParams: {},
      queryParams: {},
      requestBody: null,
      responses: [
        {
          status: 200,
          body: { token: "secret" }
        }
      ]
    }
  ];
}

async function runExport(
  scenarioPath: string,
  candidatePath: string,
  groups: ReturnType<typeof validGroups> = validGroups()
) {
  await exportScenarios({
    scenarioPath,
    candidatePath,
    getScenarioGroups: async () => groups,
    getCapturedRequests: async () => [],
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
    ).toMatchObject([
      {
        id: 1,
        request: { path: "/health" },
        expected: { body: { status: "ok" } }
      }
    ]);
  });

  it("invalidates an old artifact when sanitized response export fails", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(paths.scenarioPath, "old green");

    await expect(
      runExport(
        paths.scenarioPath,
        paths.candidatePath,
        sensitiveGroups()
      )
    ).rejects.toMatchObject<Partial<ScenarioExportError>>({
      code: "SANITIZED_RESPONSE_FIELD_UNSUPPORTED"
    });
    expect(fs.existsSync(paths.scenarioPath)).toBe(false);
  });

  it("invalidates an old artifact on arbitrary construction failure", async () => {
    const paths = temporaryPaths();
    fs.writeFileSync(paths.scenarioPath, "old green");

    await expect(
      exportScenarios({
        scenarioPath: paths.scenarioPath,
        candidatePath: paths.candidatePath,
        getScenarioGroups: async () => {
          throw new Error("construction failed");
        },
        getCapturedRequests: async () => [],
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
      getScenarioGroups: async () => [],
      getCapturedRequests: async () => [],
      log
    });

    expect(
      JSON.parse(fs.readFileSync(paths.scenarioPath, "utf8"))
    ).toEqual([]);
    expect(log).toHaveBeenCalledWith("No scenarios found.");
  });

  it("does not create an executable artifact when export fails without an old file", async () => {
    const paths = temporaryPaths();

    await expect(
      runExport(
        paths.scenarioPath,
        paths.candidatePath,
        sensitiveGroups()
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
        getScenarioGroups: async () => validGroups(),
        getCapturedRequests: async () => [],
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
        sensitiveGroups()
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
      []
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
      checks: 1,
      passedChecks: 1,
      failedChecks: 0
    });
  });
});
