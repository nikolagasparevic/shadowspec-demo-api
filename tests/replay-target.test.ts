import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  registerShadowSpecReplayTarget,
  type ShadowSpecReplayTargetOptions
} from "../src/replay-target";
import { computeReplayTargetProof } from "../src/replay-target-protocol";

const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const TARGET_ID =
  "33333333-3333-4333-8333-333333333333";
const TOKEN = "target-token-0123456789-abcdefghij";

function validOptions(): ShadowSpecReplayTargetOptions {
  return {
    enabled: true,
    projectId: PROJECT_ID,
    replayDatabaseId: DATABASE_ID,
    replayTargetId: TARGET_ID,
    token: TOKEN
  };
}

function nonce() {
  return randomBytes(32).toString("base64url");
}

describe("Fastify replay target", () => {
  afterEach(() => {
    delete process.env.SHADOWSPEC_REPLAY_TARGET;
    delete process.env.SHADOWSPEC_PROJECT_ID;
    delete process.env.SHADOWSPEC_REPLAY_DATABASE_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_ID;
    delete process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN;
  });

  it("does not register its endpoint when disabled", async () => {
    const app = Fastify();
    registerShadowSpecReplayTarget(app, {
      enabled: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/__shadowspec/replay-target",
      payload: {
        protocolVersion: 1,
        nonce: nonce()
      }
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("uses exact environment opt-in", async () => {
    process.env.SHADOWSPEC_REPLAY_TARGET = "TRUE";
    const app = Fastify();
    registerShadowSpecReplayTarget(app);

    expect(
      app.hasRoute({
        method: "POST",
        url: "/__shadowspec/replay-target"
      })
    ).toBe(false);
    await app.close();
  });

  it("uses environment fallback when explicitly enabled", async () => {
    process.env.SHADOWSPEC_REPLAY_TARGET = "true";
    process.env.SHADOWSPEC_PROJECT_ID = PROJECT_ID;
    process.env.SHADOWSPEC_REPLAY_DATABASE_ID =
      DATABASE_ID;
    process.env.SHADOWSPEC_REPLAY_TARGET_ID = TARGET_ID;
    process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN = TOKEN;
    const app = Fastify();
    registerShadowSpecReplayTarget(app);

    expect(
      app.hasRoute({
        method: "POST",
        url: "/__shadowspec/replay-target"
      })
    ).toBe(true);
    await app.close();
  });

  it.each([
    ["projectId"],
    ["replayDatabaseId"],
    ["replayTargetId"],
    ["token"]
  ] as const)(
    "fails registration when enabled without %s",
    (field) => {
      const app = Fastify();
      const options = validOptions();
      delete options[field];

      expect(() =>
        registerShadowSpecReplayTarget(
          app,
          options
        )
      ).toThrow(/required/);
    }
  );

  it("rejects a non-boolean explicit enabled value", () => {
    const app = Fastify();

    expect(() =>
      registerShadowSpecReplayTarget(
        app,
        {
          enabled: "true"
        } as unknown as ShadowSpecReplayTargetOptions
      )
    ).toThrow(/boolean/);
  });

  it.each([
    ["projectId", "bad"],
    ["replayDatabaseId", "bad"],
    ["replayTargetId", "bad"],
    ["token", "short"]
  ] as const)(
    "fails registration for invalid %s",
    (field, value) => {
      const app = Fastify();
      const options = validOptions();
      Object.assign(options, { [field]: value });

      expect(() =>
        registerShadowSpecReplayTarget(
          app,
          options
        )
      ).toThrow();
    }
  );

  it("returns identities, fresh proof, and no-store without exposing token", async () => {
    const app = Fastify();
    registerShadowSpecReplayTarget(
      app,
      validOptions()
    );
    const firstNonce = nonce();
    const secondNonce = nonce();

    const first = await app.inject({
      method: "POST",
      url: "/__shadowspec/replay-target",
      payload: {
        protocolVersion: 1,
        nonce: firstNonce
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/__shadowspec/replay-target",
      payload: {
        protocolVersion: 1,
        nonce: secondNonce
      }
    });
    const firstBody = first.json();
    const secondBody = second.json();

    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"])
      .toBe("no-store");
    expect(firstBody).toEqual({
      protocolVersion: 1,
      projectId: PROJECT_ID,
      replayDatabaseId: DATABASE_ID,
      replayTargetId: TARGET_ID,
      proof: computeReplayTargetProof(
        TOKEN,
        firstNonce,
        PROJECT_ID,
        DATABASE_ID,
        TARGET_ID
      )
    });
    expect(secondBody.proof).not.toBe(
      firstBody.proof
    );
    expect(first.body).not.toContain(TOKEN);
    await app.close();
  });

  it.each([
    {},
    { protocolVersion: 1, nonce: "short" },
    { protocolVersion: 2, nonce: nonce() },
    {
      protocolVersion: 1,
      nonce: nonce(),
      extra: true
    }
  ])("rejects malformed challenges", async (payload) => {
    const app = Fastify();
    registerShadowSpecReplayTarget(
      app,
      validOptions()
    );

    const response = await app.inject({
      method: "POST",
      url: "/__shadowspec/replay-target",
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(TOKEN);
    await app.close();
  });

  it("does not explicitly log token, nonce, or proof", async () => {
    const info = vi.fn();
    const error = vi.fn();
    const silentLogger: any = {
      level: "silent",
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn()
    };
    const logger: any = {
      level: "info",
      fatal: vi.fn(),
      error,
      warn: vi.fn(),
      info,
      debug: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(
        (_bindings, options) =>
          options?.level === "silent"
            ? silentLogger
            : logger
      )
    };
    const app = Fastify({ loggerInstance: logger });
    registerShadowSpecReplayTarget(
      app,
      validOptions()
    );
    const challenge = nonce();

    const response = await app.inject({
      method: "POST",
      url: "/__shadowspec/replay-target",
      payload: {
        protocolVersion: 1,
        nonce: challenge
      }
    });
    const proof = response.json().proof;
    const logged = JSON.stringify([
      info.mock.calls,
      error.mock.calls
    ]);

    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(challenge);
    expect(logged).not.toContain(proof);
    await app.close();
  });
});
