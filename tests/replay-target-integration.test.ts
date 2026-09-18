import Fastify, {
  type FastifyInstance
} from "fastify";
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";
import { registerShadowSpecReplayTarget } from "../src/replay-target";
import { replayRequest } from "../src/replay";

const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const TARGET_ID =
  "33333333-3333-4333-8333-333333333333";
const TOKEN = "target-token-0123456789-abcdefghij";
const environmentKeys = [
  "SHADOWSPEC_TARGET_URL",
  "SHADOWSPEC_PROJECT_ID",
  "SHADOWSPEC_REPLAY_DATABASE_ID",
  "SHADOWSPEC_REPLAY_TARGET_ID",
  "SHADOWSPEC_REPLAY_TARGET_TOKEN"
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [
    key,
    process.env[key]
  ])
);
const applications: FastifyInstance[] = [];

async function listen(
  app: FastifyInstance,
  port = 0
) {
  applications.push(app);
  return app.listen({
    host: "127.0.0.1",
    port
  });
}

function configureRunner(origin: string) {
  process.env.SHADOWSPEC_TARGET_URL = origin;
  process.env.SHADOWSPEC_PROJECT_ID = PROJECT_ID;
  process.env.SHADOWSPEC_REPLAY_DATABASE_ID =
    DATABASE_ID;
  process.env.SHADOWSPEC_REPLAY_TARGET_ID =
    TARGET_ID;
  process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN = TOKEN;
}

function authorizedApp(
  overrides: {
    targetId?: string;
    token?: string;
  } = {}
) {
  const app = Fastify();
  registerShadowSpecReplayTarget(app, {
    enabled: true,
    projectId: PROJECT_ID,
    replayDatabaseId: DATABASE_ID,
    replayTargetId:
      overrides.targetId ?? TARGET_ID,
    token: overrides.token ?? TOKEN
  });
  return app;
}

describe("replay target integration", () => {
  afterEach(async () => {
    await Promise.all(
      applications.splice(0).map((app) =>
        app.close()
      )
    );

    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("allows an authorized target request", async () => {
    const app = authorizedApp();
    let scenarioRequests = 0;
    app.get("/resource", async () => {
      scenarioRequests++;
      return { ok: true };
    });
    const origin = await listen(app);
    configureRunner(origin);

    const result = await replayRequest(
      "GET",
      "/resource",
      null
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true }
    });
    expect(scenarioRequests).toBe(1);
  });

  it.each([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE"
  ] as const)(
    "sends zero %s scenario requests to a target with replay mode disabled",
    async (method) => {
      const app = Fastify();
      registerShadowSpecReplayTarget(app, {
        enabled: false
      });
      let scenarioRequests = 0;
      app.route({
        method,
        url: "/resource",
        handler: async () => {
          scenarioRequests++;
          return { ok: true };
        }
      });
      const origin = await listen(app);
      configureRunner(origin);

      await expect(
        replayRequest(method, "/resource", {
          value: true
        })
      ).rejects.toMatchObject({
        code: "REPLAY_TARGET_HANDSHAKE_MISSING"
      });
      expect(scenarioRequests).toBe(0);
    }
  );

  it("sends zero scenario requests to a target with the wrong identity", async () => {
    const app = authorizedApp({
      targetId:
        "44444444-4444-4444-8444-444444444444"
    });
    let scenarioRequests = 0;
    app.post("/resource", async () => {
      scenarioRequests++;
      return { ok: true };
    });
    const origin = await listen(app);
    configureRunner(origin);

    await expect(
      replayRequest("POST", "/resource", {})
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_ID_MISMATCH"
    });
    expect(scenarioRequests).toBe(0);
  });

  it("detects a target token change before the next lifecycle request", async () => {
    const app = authorizedApp();
    let scenarioRequests = 0;
    app.get("/resource", async () => {
      scenarioRequests++;
      return { ok: true };
    });
    const origin = await listen(app);
    configureRunner(origin);

    await replayRequest("GET", "/resource", null);
    process.env.SHADOWSPEC_REPLAY_TARGET_TOKEN =
      "changed-target-token-0123456789-abcd";

    await expect(
      replayRequest("GET", "/resource", null)
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_PROOF_INVALID"
    });
    expect(scenarioRequests).toBe(1);
  });

  it("detects a restarted target with the wrong identity", async () => {
    const first = authorizedApp();
    first.get("/resource", async () => ({ ok: true }));
    const origin = await listen(first);
    configureRunner(origin);

    await replayRequest("GET", "/resource", null);
    await first.close();
    applications.splice(
      applications.indexOf(first),
      1
    );

    const port = Number(new URL(origin).port);
    const restarted = authorizedApp({
      targetId:
        "44444444-4444-4444-8444-444444444444"
    });
    let scenarioRequests = 0;
    restarted.get("/resource", async () => {
      scenarioRequests++;
      return { ok: true };
    });
    await listen(restarted, port);

    const failure = await replayRequest(
      "GET",
      "/resource",
      null
    ).catch((error: unknown) => error);
    expect([
      "REPLAY_TARGET_UNREACHABLE",
      "REPLAY_TARGET_ID_MISMATCH"
    ]).toContain(
      (failure as { code?: string }).code
    );
    expect(scenarioRequests).toBe(0);
  });

  it("never follows a handshake redirect to another service", async () => {
    const victim = Fastify();
    let victimRequests = 0;
    victim.all("/*", async () => {
      victimRequests++;
      return { unsafe: true };
    });
    const victimOrigin = await listen(victim);

    const redirector = Fastify();
    redirector.post(
      "/__shadowspec/replay-target",
      async (_request, reply) =>
        reply.redirect(`${victimOrigin}/unsafe`)
    );
    const redirectOrigin = await listen(redirector);
    configureRunner(redirectOrigin);

    await expect(
      replayRequest("DELETE", "/resource", null)
    ).rejects.toMatchObject({
      code: "REPLAY_TARGET_REDIRECT_REFUSED"
    });
    expect(victimRequests).toBe(0);
  });

  it("returns raw scenario redirects without contacting their destination", async () => {
    const victim = Fastify();
    let victimRequests = 0;
    victim.get("/destination", async () => {
      victimRequests++;
      return { reached: true };
    });
    const victimOrigin = await listen(victim);

    const app = authorizedApp();
    app.get("/redirect", async (_request, reply) =>
      reply
        .header(
          "Location",
          `${victimOrigin}/destination`
        )
        .code(302)
        .send({ redirected: true })
    );
    const origin = await listen(app);
    configureRunner(origin);

    const result = await replayRequest(
      "GET",
      "/redirect",
      null
    );

    expect(result).toEqual({
      status: 302,
      body: { redirected: true }
    });
    expect(victimRequests).toBe(0);
  });

  it("rejects a scenario authority escape after an authorized handshake", async () => {
    const alternate = Fastify();
    let alternateRequests = 0;
    alternate.all("/*", async () => {
      alternateRequests++;
      return { reached: true };
    });
    const alternateOrigin = await listen(alternate);

    const app = authorizedApp();
    let scenarioRequests = 0;
    app.all("/*", async () => {
      scenarioRequests++;
      return { ok: true };
    });
    const origin = await listen(app);
    configureRunner(origin);

    const alternateAuthority =
      new URL(alternateOrigin).host;

    await expect(
      replayRequest(
        "GET",
        `//${alternateAuthority}/unsafe`,
        null
      )
    ).rejects.toMatchObject({
      name: "ReplayTargetSafetyError",
      code: "REPLAY_TARGET_REQUEST_URL_INVALID",
      message:
        "Scenario request URL is not confined to the verified replay target."
    });

    expect(alternateRequests).toBe(0);
    expect(scenarioRequests).toBe(0);
  });
});
