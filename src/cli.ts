#!/usr/bin/env node

import { runExportCli } from "./export-scenarios";
import { runReplayCli } from "./run-replay";
import {
  PurgeError,
  runPurgeCli
} from "./purge";

const command = process.argv[2];

switch (command) {
  case "export":
    runExportCli();
    break;

  case "replay":
    runReplayCli();
    break;

  case "purge":
    runPurgeCli().catch((error) => {
      if (error instanceof PurgeError) {
        console.error(
          `${error.code}: ${error.message}`
        );
      } else {
        console.error(
          "PURGE_QUERY_FAILED: ShadowSpec purge failed."
        );
      }

      process.exitCode = 1;
    });
    break;

  default:
    console.error(
      "Usage: shadowspec <export|replay|purge>"
    );
    process.exitCode = 1;
}
