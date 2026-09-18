import Fastify from "fastify";
import { Pool } from "pg";
import {
  registerShadowSpec,
  registerShadowSpecReplayTarget,
  type ShadowSpecReplayTargetOptions,
  type ShadowSpecOptions
} from "shadowspec";

const app = Fastify();
const applicationPool = new Pool();

const options: ShadowSpecOptions = {
  applicationPool,
  enabled: false,
  tables: ["books"]
};

registerShadowSpec(app, options);

const replayTargetOptions:
  ShadowSpecReplayTargetOptions = {
  enabled: false
};

registerShadowSpecReplayTarget(
  app,
  replayTargetOptions
);
