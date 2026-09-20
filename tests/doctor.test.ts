import fs from "node:fs";
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
    DoctorError,
    runDoctor,
    runDoctorCli
} from "../src/doctor";

const tempDirs: string[] = [];

function createProject(
    packageJson: unknown,
    config?: unknown
): string {
    const dir =
        fs.mkdtempSync(
            path.join(
                os.tmpdir(),
                "shadowspec-doctor-"
            )
        );

    tempDirs.push(dir);

    fs.writeFileSync(
        path.join(
            dir,
            "package.json"
        ),
        JSON.stringify(
            packageJson,
            null,
            2
        )
    );

    if (config !== undefined) {
        fs.writeFileSync(
            path.join(
                dir,
                "shadowspec.config.json"
            ),
            JSON.stringify(
                config,
                null,
                2
            )
        );
    }

    return dir;
}

afterEach(() => {
    vi.restoreAllMocks();

    process.exitCode = undefined;

    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(
            dir,
            {
                recursive: true,
                force: true
            }
        );
    }
});

describe("ShadowSpec doctor", () => {
    it("passes a valid configured project", () => {
        const cwd =
            createProject(
                {
                    dependencies: {
                        shadowspec: "0.1.0",
                        fastify: "5.12.4",
                        pg: "8.23.0"
                    }
                },
                {
                    schema: "public",
                    tables: [
                        "orders"
                    ],
                    capture: {
                        enabled: true
                    },
                    privacy: {
                        snapshotAllowedColumns: {
                            orders: [
                                "id",
                                "status"
                            ]
                        }
                    }
                }
            );

        const result =
            runDoctor(cwd);

        expect(
            result.failed
        ).toBe(0);

        expect(
            result.review
        ).toBe(0);

        expect(
            result.passed
        ).toBe(8);
    });

    it("marks empty snapshot privacy as review instead of failure", () => {
        const cwd =
            createProject(
                {
                    dependencies: {
                        shadowspec: "0.1.0",
                        fastify: "5.12.4",
                        pg: "8.23.0"
                    }
                },
                {
                    schema: "public",
                    tables: [
                        "orders"
                    ],
                    capture: {
                        enabled: true
                    },
                    privacy: {
                        snapshotAllowedColumns: {}
                    }
                }
            );

        const result =
            runDoctor(cwd);

        expect(
            result.failed
        ).toBe(0);

        expect(
            result.review
        ).toBe(1);

        expect(
            result.checks
        ).toContainEqual(
            expect.objectContaining({
                label:
                    "snapshot privacy",
                status: "REVIEW"
            })
        );
    });

    it("marks empty tables as review instead of failure", () => {
        const cwd =
            createProject(
                {
                    dependencies: {
                        shadowspec: "0.1.0",
                        fastify: "5.12.4",
                        pg: "8.23.0"
                    }
                },
                {
                    schema: "public",
                    tables: [],
                    capture: {
                        enabled: true
                    },
                    privacy: {
                        snapshotAllowedColumns: {}
                    }
                }
            );

        const result =
            runDoctor(cwd);

        expect(
            result.failed
        ).toBe(0);

        expect(
            result.review
        ).toBe(2);
    });

    it("fails when package.json is missing", () => {
        const cwd =
            fs.mkdtempSync(
                path.join(
                    os.tmpdir(),
                    "shadowspec-doctor-"
                )
            );

        tempDirs.push(cwd);

        fs.writeFileSync(
            path.join(
                cwd,
                "shadowspec.config.json"
            ),
            JSON.stringify({
                schema: "public",
                tables: [],
                privacy: {
                    snapshotAllowedColumns: {}
                }
            })
        );

        const result =
            runDoctor(cwd);

        expect(
            result.failed
        ).toBeGreaterThan(0);

        expect(
            result.checks
        ).toContainEqual(
            expect.objectContaining({
                label: "package.json",
                status: "FAIL"
            })
        );
    });

    it("fails when the config is missing", () => {
        const cwd =
            createProject({
                dependencies: {
                    shadowspec: "0.1.0",
                    fastify: "5.12.4",
                    pg: "8.23.0"
                }
            });

        const result =
            runDoctor(cwd);

        expect(
            result.failed
        ).toBe(4);

        expect(
            result.checks
        ).toContainEqual(
            expect.objectContaining({
                label:
                    "shadowspec.config.json",
                status: "FAIL"
            })
        );
    });

    it("fails invalid tables configuration", () => {
        const cwd =
            createProject(
                {
                    dependencies: {
                        shadowspec: "0.1.0",
                        fastify: "5.12.4",
                        pg: "8.23.0"
                    }
                },
                {
                    schema: "public",
                    tables: [
                        "orders",
                        ""
                    ],
                    privacy: {
                        snapshotAllowedColumns: {}
                    }
                }
            );

        const result =
            runDoctor(cwd);

        expect(
            result.checks
        ).toContainEqual(
            expect.objectContaining({
                label: "tables",
                status: "FAIL"
            })
        );
    });

    it("rejects unknown doctor arguments", () => {
        expect(
            () =>
                runDoctorCli([
                    "--unknown"
                ])
        ).toThrowError(
            DoctorError
        );

        expect(
            () =>
                runDoctorCli([
                    "--unknown"
                ])
        ).toThrow(
            "Unknown doctor argument"
        );
    });

    it("sets a failing exit code when doctor finds failures", () => {
        const cwd =
            fs.mkdtempSync(
                path.join(
                    os.tmpdir(),
                    "shadowspec-doctor-"
                )
            );

        tempDirs.push(cwd);

        const originalCwd =
            process.cwd();

        vi.spyOn(
            process,
            "cwd"
        ).mockReturnValue(cwd);

        vi.spyOn(
            console,
            "log"
        ).mockImplementation(
            () => { }
        );

        try {
            runDoctorCli([]);

            expect(
                process.exitCode
            ).toBe(1);
        } finally {
            vi.mocked(
                process.cwd
            ).mockRestore();

            process.chdir(
                originalCwd
            );
        }
    });
});