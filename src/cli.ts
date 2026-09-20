#!/usr/bin/env node

import { runExportCli } from "./export-scenarios";
import { runReplayCli } from "./run-replay";
import {
  InitError,
  runInitCli
} from "./init";
import {
  DoctorError,
  runDoctorCli
} from "./doctor";
import {
  PurgeError,
  runPurgeCli
} from "./purge";

const command =
  process.argv[2];

switch (command) {
  case "export":
    runExportCli();
    break;

  case "replay":
    runReplayCli();
    break;

  case "init":
    runInitCli().catch(
      (error) => {
        if (
          error instanceof InitError
        ) {
          console.error(
            `${error.code}: ${error.message}`
          );
        } else {
          console.error(
            "INIT_WRITE_FAILED: ShadowSpec init failed."
          );
        }

        process.exitCode = 1;
      }
    );
    break;

  case "doctor":
    try {
      runDoctorCli();
    } catch (error) {
      if (
        error instanceof DoctorError
      ) {
        console.error(
          `${error.code}: ${error.message}`
        );
      } else {
        console.error(
          "DOCTOR_FAILED: ShadowSpec doctor failed."
        );
      }

      process.exitCode = 1;
    }
    break;

  case "purge":
    runPurgeCli().catch(
      (error) => {
        if (
          error instanceof PurgeError
        ) {
          console.error(
            `${error.code}: ${error.message}`
          );
        } else {
          console.error(
            "PURGE_QUERY_FAILED: ShadowSpec purge failed."
          );
        }

        process.exitCode = 1;
      }
    );
    break;

  default:
    console.error(
      "Usage: shadowspec <init|doctor|export|replay|purge>"
    );
    process.exitCode = 1;
}