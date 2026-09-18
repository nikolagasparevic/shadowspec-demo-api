import {
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  parseReplayTargetSafetyConfig,
  verifyReplayTarget
} from "../src/replay-target-safety";
import { computeReplayTargetProof } from "../src/replay-target-protocol";

const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const TARGET_ID =
  "33333333-3333-4333-8333-333333333333";
const TOKEN = "target-token-0123456789-abcdefghij";
const NONCE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function environment(): NodeJS.ProcessEnv {
  return {
    SHADOWSPEC_TARGET_URL: "http://127.0.0.1:4000",
    SHADOWSPEC_PROJECT_ID: PROJECT_ID,
    SHADOWSPEC_REPLAY_DATABASE_ID: DATABASE_ID,
    SHADOWSPEC_REPLAY_TARGET_ID: TARGET_ID,
    SHADOWSPEC_REPLAY_TARGET_TOKEN: TOKEN
  };
}

function handshake(
  overrides: Record<string, unknown> = {},
  proofNonce = NONCE
) {
  return {
    protocolVersion: 1,
    projectId: PROJECT_ID,
    replayDatabaseId: DATABASE_ID,
    replayTargetId: TARGET_ID,
    proof: computeReplayTargetProof(
      TOKEN,
      proofNonce,
      PROJECT_ID,
      DATABASE_ID,
      TARGET_ID
    ),
    ...overrides
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });
}

describe("replay target safety configuration", () => {
  it.each([
    "SHADOWSPEC_TARGET_URL",
    "SHADOWSPEC_PROJECT_ID",
    "SHADOWSPEC_REPLAY_DATABASE_ID",
    "SHADOWSPEC_REPLAY_TARGET_ID",
    "SHADOWSPEC_REPLAY_TARGET_TOKEN"
  ])("rejects missing %s", (name) => {
    const env = environment();
    delete env[name];

    expect(() =>
      parseReplayTargetSafetyConfig(env)
    ).toThrowError(
      expect.objectContaining({
        code: "REPLAY_TARGET_CONFIG_MISSING"
      })
    );
  });

  it.each([
    "SHADOWSPEC_PROJECT_ID",
    "SHADOWSPEC_REPLAY_DATABASE_ID",
    "SHADOWSPEC_REPLAY_TARGET_ID"
  ])("rejects invalid UUID in %s", (name) => {
    const env = environment();
    env[name] = "invalid";

    expect(() =>
      parseReplayTargetSafetyConfig(env)
    ).toThrowError(
      expect.objectContaining({
        code: "REPLAY_TARGET_CONFIG_INVALID"
      })
    );
  });

  it("rejects weak target tokens", () => {
    const env = environment();
    env.SHADOWSPEC_REPLAY_TARGET_TOKEN = "short";

    expect(() =>
      parseReplayTargetSafetyConfig(env)
    ).toThrowError(
      expect.objectContaining({
        code: "REPLAY_TARGET_CONFIG_INVALID"
      })
    );
  });

  it.each([
    "relative",
    "ftp://example.test",
    "http://user:pass@example.test",
    "http://example.test/path",
    "http://example.test?query=yes",
    "http://example.test#fragment"
  ])("rejects unsafe target URL %s", (url) => {
    const env = environment();
    env.SHADOWSPEC_TARGET_URL = url;

    expect(() =>
      parseReplayTargetSafetyConfig(env)
    ).toThrowError(
      expect.objectContaining({
        code: "REPLAY_TARGET_URL_INVALID"
      })
    );
  });

  it("normalizes UUIDs and the target origin", () => {
    const env = environment();
    env.SHADOWSPEC_PROJECT_ID =
      PROJECT_ID.toUpperCase();
    env.SHADOWSPEC_TARGET_URL =
      "http://127.0.0.1:4000/";

    expect(
      parseReplayTargetSafetyConfig(env)
    ).toMatchObject({
      targetOrigin: "http://127.0.0.1:4000",
      projectId: PROJECT_ID
    });
  });
});

describe("replay target handshake", () => {
  it("sends a bounded manual-redirect challenge and accepts a correct proof", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(handshake())
    );

    await verifyReplayTarget(
      environment(),
      fetchMock,
      100,
      NONCE
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:4000/__shadowspec/replay-target"
    );
    expect(options).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: 1,
        nonce: NONCE
      })
    });
  });

  it.each([
    [404, "REPLAY_TARGET_HANDSHAKE_MISSING"],
    [401, "REPLAY_TARGET_HANDSHAKE_REJECTED"],
    [500, "REPLAY_TARGET_HANDSHAKE_REJECTED"],
    [302, "REPLAY_TARGET_REDIRECT_REFUSED"]
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetchMock = vi.fn(async () =>
      new Response("", {
        status,
        headers: status === 302
          ? { Location: "https://production.test" }
          : undefined
      })
    );

    await expect(
      verifyReplayTarget(
        environment(),
        fetchMock,
        100,
        NONCE
      )
    ).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when target is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED secret-host");
    });

    const failure = await verifyReplayTarget(
      environment(),
      fetchMock,
      100,
      NONCE
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "REPLAY_TARGET_UNREACHABLE"
    });
    expect(String(failure)).not.toContain("secret-host");
  });

  it("times out the full handshake", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(
              new DOMException("aborted", "AbortError")
            )
          );
        })
    );

    await expect(
      verifyReplayTarget(
        environment(),
        fetchMock,
        5,
        NONCE
      )
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_TIMEOUT"
    });
  });

  it.each([
    ["not-json", "non-JSON"],
    [JSON.stringify(null), "null"],
    [JSON.stringify({}), "empty object"],
    [JSON.stringify({ ...handshake(), extra: true }), "extra field"]
  ])("rejects %s response", async (body) => {
    const fetchMock = vi.fn(async () =>
      new Response(body, { status: 200 })
    );

    await expect(
      verifyReplayTarget(
        environment(),
        fetchMock,
        100,
        NONCE
      )
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_RESPONSE_INVALID"
    });
  });

  it("rejects oversized responses", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("x".repeat(8 * 1024 + 1), {
        status: 200
      })
    );

    await expect(
      verifyReplayTarget(
        environment(),
        fetchMock,
        100,
        NONCE
      )
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_RESPONSE_INVALID"
    });
  });

  it.each([
    [
      { protocolVersion: 2 },
      "REPLAY_TARGET_PROTOCOL_UNSUPPORTED"
    ],
    [
      { projectId: "44444444-4444-4444-8444-444444444444" },
      "REPLAY_TARGET_PROJECT_MISMATCH"
    ],
    [
      { replayDatabaseId: "44444444-4444-4444-8444-444444444444" },
      "REPLAY_TARGET_DATABASE_ID_MISMATCH"
    ],
    [
      { replayTargetId: "44444444-4444-4444-8444-444444444444" },
      "REPLAY_TARGET_ID_MISMATCH"
    ],
    [
      { proof: "not-a-proof" },
      "REPLAY_TARGET_PROOF_INVALID"
    ],
    [
      { proof: "0".repeat(64) },
      "REPLAY_TARGET_PROOF_INVALID"
    ]
  ])("rejects mismatched handshake %#", async (override, code) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(handshake(override))
    );

    await expect(
      verifyReplayTarget(
        environment(),
        fetchMock,
        100,
        NONCE
      )
    ).rejects.toMatchObject({ code });
  });

  it("rejects stale proofs from another nonce", async () => {
    const staleNonce =
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const fetchMock = vi.fn(async () =>
      jsonResponse(handshake({}, staleNonce))
    );

    await expect(
      verifyReplayTarget(
        environment(),
        fetchMock,
        100,
        NONCE
      )
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_PROOF_INVALID"
    });
  });

  it("does not expose secrets in validation errors", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(handshake({ proof: "0".repeat(64) }))
    );
    const failure = await verifyReplayTarget(
      environment(),
      fetchMock,
      100,
      NONCE
    ).catch((error: unknown) => error);
    const message = String(failure);

    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(NONCE);
    expect(message).not.toContain("0".repeat(64));
  });
});
