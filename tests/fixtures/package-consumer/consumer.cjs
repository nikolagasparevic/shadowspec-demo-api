const assert = require("node:assert/strict");
const shadowspec = require("shadowspec");

assert.deepEqual(
  Object.keys(shadowspec),
  [
    "registerShadowSpec",
    "registerShadowSpecReplayTarget"
  ]
);

assert.equal(
  typeof shadowspec.registerShadowSpec,
  "function"
);

assert.equal(
  typeof shadowspec.registerShadowSpecReplayTarget,
  "function"
);

assert.throws(
  () => require(
    "shadowspec/dist/replay-target-protocol"
  ),
  (error) =>
    error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
);

assert.match(
  require.resolve(
    "shadowspec/capture-schema.sql"
  ),
  /capture-schema\.sql$/
);

assert.match(
  require.resolve(
    "shadowspec/replay-target-schema.sql"
  ),
  /replay-target-schema\.sql$/
);
