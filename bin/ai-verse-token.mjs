#!/usr/bin/env node
import { runCli } from "../dist/src/cli.js";

const code = runCli(process.argv.slice(2), {
  stdout(value) {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  },
  stderr(value) {
    process.stderr.write(value.endsWith("\n") ? value : `${value}\n`);
  }
});

process.exitCode = code;
