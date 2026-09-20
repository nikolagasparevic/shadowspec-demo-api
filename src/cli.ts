#!/usr/bin/env node

import { runExportCli } from "./export-scenarios";
import { runReplayCli } from "./run-replay";

const command = process.argv[2];

switch (command) {
  case "export":
    runExportCli();
    break;

  case "replay":
    runReplayCli();
    break;

  default:
    console.error(
      "Usage: shadowspec <export|replay>"
    );
    process.exitCode = 1;
}