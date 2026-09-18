import { createHash } from "node:crypto";
import {
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { PoolClient } from "pg";
import {
  parseReplaySafetyConfig,
  preflightReplaySafety,
  type ReplayPool
} from "../src/replay-safety";
import { applyReplaySetup } from "../src/setup-replay";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const DATABASE_NAME = "safe_replay";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    SHADOWSPEC_REPLAY: "true",
    SHADOWSPEC_PROJECT_ID: PROJECT_ID,
    SHADOWSPEC_REPLAY_DATABASE_ID: DATABASE_ID,
    SHADOWSPEC_REPLAY_TOKEN: TOKEN,
    SHADOWSPEC_REPLAY_DATABASE_NAME:
      DATABASE_NAME,
    SHADOWSPEC_TABLES: "orders"
  };
}

function validMarker() {
  return {
    marker_version: 1,
    project_id: PROJECT_ID,
    replay_database_id: DATABASE_ID,
    database_name: DATABASE_NAME,
    token_sha256: createHash("sha256")
      .update(TOKEN)
      .digest("hex")
  };
}

type HarnessOptions = {
  currentDatabase?: string;
  marker?: Record<string, unknown> | null;
  markerErrorCode?: string;
  rollbackFails?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const query = vi.fn(async (sql: string) => {
    if (
      options.rollbackFails &&
      sql === "ROLLBACK"
    ) {
      throw new Error("rollback connection failure");
    }

    if (sql.includes("current_database()")) {
      return {
        rows: [{
          database_name:
            options.currentDatabase ?? DATABASE_NAME
        }]
      };
    }

    if (
      sql.includes(
        "shadowspec_internal.replay_target"
      )
    ) {
      if (options.markerErrorCode) {
        throw Object.assign(
          new Error("database marker error"),
          { code: options.markerErrorCode }
        );
      }

      return {
        rows: options.marker === null
          ? []
          : [options.marker ?? validMarker()]
      };
    }

    return { rows: [] };
  });
  const release = vi.fn();
  const client = {
    query,
    release
  } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as ReplayPool;

  return { pool, connect, query, release };
}

function expectNoMutations(
  query: ReturnType<typeof vi.fn>
) {
  const sql = query.mock.calls.map(
    ([statement]) => statement as string
  );

  expect(
    sql.some((statement) =>
      statement.startsWith("TRUNCATE") ||
      statement.startsWith("INSERT") ||
      statement.includes("setval(")
    )
  ).toBe(false);
}

describe("replay safety configuration", () => {
  it.each([
    [undefined, "missing"],
    ["false", "false"],
    ["TRUE", "non-exact"]
  ])("rejects %s replay opt-in", async (value) => {
    const env = validEnvironment();
    if (value === undefined) {
      delete env.SHADOWSPEC_REPLAY;
    } else {
      env.SHADOWSPEC_REPLAY = value;
    }
    const test = harness();

    await expect(
      preflightReplaySafety(test.pool, env)
    ).rejects.toMatchObject({
      code: "REPLAY_OPT_IN_REQUIRED"
    });
    expect(test.connect).not.toHaveBeenCalled();
    expectNoMutations(test.query);
  });

  it.each([
    "SHADOWSPEC_PROJECT_ID",
    "SHADOWSPEC_REPLAY_DATABASE_ID",
    "SHADOWSPEC_REPLAY_TOKEN",
    "SHADOWSPEC_REPLAY_DATABASE_NAME"
  ])("rejects missing %s before connecting", async (name) => {
    const env = validEnvironment();
    delete env[name];
    const test = harness();

    await expect(
      preflightReplaySafety(test.pool, env)
    ).rejects.toMatchObject({
      code: "REPLAY_SAFETY_CONFIG_MISSING"
    });
    expect(test.connect).not.toHaveBeenCalled();
    expectNoMutations(test.query);
  });

  it.each([
    ["SHADOWSPEC_PROJECT_ID", "not-a-uuid"],
    ["SHADOWSPEC_REPLAY_DATABASE_ID", "bad"],
    ["SHADOWSPEC_REPLAY_TOKEN", "too-short"],
    ["SHADOWSPEC_REPLAY_DATABASE_NAME", " unsafe "]
  ])("rejects invalid %s before connecting", async (name, value) => {
    const env = validEnvironment();
    env[name] = value;
    const test = harness();

    await expect(
      preflightReplaySafety(test.pool, env)
    ).rejects.toMatchObject({
      code: "REPLAY_SAFETY_CONFIG_INVALID"
    });
    expect(test.connect).not.toHaveBeenCalled();
    expectNoMutations(test.query);
  });

  it("returns an immutable validated config", () => {
    const config = parseReplaySafetyConfig(
      validEnvironment()
    );

    expect(Object.isFrozen(config)).toBe(true);
    expect(config).toMatchObject({
      projectId: PROJECT_ID,
      replayDatabaseId: DATABASE_ID,
      replayDatabaseName: DATABASE_NAME
    });
  });
});

describe("replay marker verification", () => {
  it.each([
    ["42P01", "REPLAY_MARKER_TABLE_MISSING"],
    ["42501", "REPLAY_MARKER_UNREADABLE"]
  ])("maps PostgreSQL %s to %s", async (pgCode, safetyCode) => {
    const test = harness({ markerErrorCode: pgCode });

    await expect(
      preflightReplaySafety(
        test.pool,
        validEnvironment()
      )
    ).rejects.toMatchObject({ code: safetyCode });
    expectNoMutations(test.query);
    expect(test.release).toHaveBeenCalledWith(false);
  });

  it("rejects a missing marker row", async () => {
    const test = harness({ marker: null });

    await expect(
      preflightReplaySafety(
        test.pool,
        validEnvironment()
      )
    ).rejects.toMatchObject({
      code: "REPLAY_MARKER_ROW_MISSING"
    });
    expectNoMutations(test.query);
  });

  it("uses a structured safety error for an unexpected marker read failure", async () => {
    const test = harness({
      markerErrorCode: "XX000"
    });

    await expect(
      preflightReplaySafety(
        test.pool,
        validEnvironment()
      )
    ).rejects.toMatchObject({
      code: "REPLAY_SAFETY_CHECK_FAILED"
    });
    expectNoMutations(test.query);
  });

  it.each([
    [
      { marker_version: 2 },
      "REPLAY_MARKER_VERSION_UNSUPPORTED"
    ],
    [
      { token_sha256: "not-a-hash" },
      "REPLAY_MARKER_INVALID"
    ],
    [
      { project_id: "33333333-3333-4333-8333-333333333333" },
      "REPLAY_PROJECT_MISMATCH"
    ],
    [
      { replay_database_id: "44444444-4444-4444-8444-444444444444" },
      "REPLAY_DATABASE_ID_MISMATCH"
    ],
    [
      { token_sha256: "0".repeat(64) },
      "REPLAY_TOKEN_MISMATCH"
    ],
    [
      { database_name: "different_database" },
      "REPLAY_DATABASE_NAME_MISMATCH"
    ]
  ])("rejects marker mismatch %#", async (override, code) => {
    const test = harness({
      marker: { ...validMarker(), ...override }
    });

    await expect(
      preflightReplaySafety(
        test.pool,
        validEnvironment()
      )
    ).rejects.toMatchObject({ code });
    expectNoMutations(test.query);
  });

  it("rejects current_database mismatch", async () => {
    const test = harness({
      currentDatabase: "wrong_database"
    });

    await expect(
      preflightReplaySafety(
        test.pool,
        validEnvironment()
      )
    ).rejects.toMatchObject({
      code: "REPLAY_DATABASE_NAME_MISMATCH"
    });
    expectNoMutations(test.query);
  });

  it("does not trust a _replay database name without a marker", async () => {
    const env = validEnvironment();
    env.SHADOWSPEC_REPLAY_DATABASE_NAME =
      "looks_safe_replay";
    const test = harness({
      currentDatabase: "looks_safe_replay",
      marker: null
    });

    await expect(
      preflightReplaySafety(test.pool, env)
    ).rejects.toMatchObject({
      code: "REPLAY_MARKER_ROW_MISSING"
    });
    expectNoMutations(test.query);
  });

  it("accepts a valid marker in a read-only transaction", async () => {
    const test = harness();

    await preflightReplaySafety(
      test.pool,
      validEnvironment()
    );

    const sql = test.query.mock.calls.map(
      ([statement]) => statement as string
    );
    expect(sql[0]).toBe("BEGIN READ ONLY");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(
      sql.find((statement) =>
        statement.includes("replay_target")
      )
    ).not.toContain("FOR SHARE");
    expectNoMutations(test.query);
  });

  it("never connects when opt-in is absent even with a valid marker", async () => {
    const env = validEnvironment();
    delete env.SHADOWSPEC_REPLAY;
    const test = harness();

    await expect(
      preflightReplaySafety(test.pool, env)
    ).rejects.toMatchObject({
      code: "REPLAY_OPT_IN_REQUIRED"
    });
    expect(test.connect).not.toHaveBeenCalled();
  });

  it("destroys a client when rollback fails and preserves the original code", async () => {
    const test = harness({
      marker: null,
      rollbackFails: true
    });

    const failure = await preflightReplaySafety(
      test.pool,
      validEnvironment()
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "REPLAY_MARKER_ROW_MISSING"
    });
    expect(failure).toHaveProperty(
      "rollbackFailure"
    );
    expect(test.release).toHaveBeenCalledWith(true);
  });

  it("permits destructive setup only after a valid marker", async () => {
    const test = harness();

    await applyReplaySetup(
      {
        tables: {
          orders: { rows: [{ id: 1 }] }
        }
      },
      test.pool,
      validEnvironment()
    );

    const sql = test.query.mock.calls.map(
      ([statement]) => statement as string
    );
    const markerIndex = sql.findIndex((statement) =>
      statement.includes("replay_target")
    );
    const mutationIndex = sql.findIndex((statement) =>
      statement.startsWith("TRUNCATE")
    );
    expect(markerIndex).toBeGreaterThan(-1);
    expect(mutationIndex).toBeGreaterThan(markerIndex);
  });

  it("performs zero setup mutations when authoritative marker verification fails", async () => {
    const test = harness({ marker: null });

    await expect(
      applyReplaySetup(
        {
          tables: {
            orders: { rows: [{ id: 1 }] }
          }
        },
        test.pool,
        validEnvironment()
      )
    ).rejects.toMatchObject({
      code: "REPLAY_MARKER_ROW_MISSING"
    });
    expectNoMutations(test.query);
  });
});
