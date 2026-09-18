const assert = require("node:assert/strict");
const shadowspec = require("shadowspec");

assert.deepEqual(
  Object.keys(shadowspec),
  ["registerShadowSpec"]
);

assert.equal(
  typeof shadowspec.registerShadowSpec,
  "function"
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
