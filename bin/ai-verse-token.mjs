#!/usr/bin/env node
import { runCliAsync } from "../dist/src/cli.js";

const code = await runCliAsync(process.argv.slice(2), {
  stdout(value) {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  },
  stderr(value) {
    process.stderr.write(value.endsWith("\n") ? value : `${value}\n`);
  }
});

process.exitCode = code;
