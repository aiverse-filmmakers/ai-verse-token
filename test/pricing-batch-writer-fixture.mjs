import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { sep } from "node:path";
import { PriceSnapshotStore } from "../dist/src/pricing/index.js";

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const config = JSON.parse(process.env.AI_VERSE_TOKEN_BATCH_FIXTURE ?? "null");
if (!config || typeof config.root !== "string" || typeof config.start_file !== "string" || !Array.isArray(config.batch)) {
  throw new Error("invalid pricing batch writer fixture configuration");
}

while (!existsSync(config.start_file)) sleep(5);

if (config.mode === "crash_after_first_stage_member") {
  const originalWriteFileSync = fs.writeFileSync;
  let stagedMembers = 0;
  fs.writeFileSync = function patchedWriteFileSync(path, data, options) {
    const result = originalWriteFileSync.call(fs, path, data, options);
    const normalized = String(path);
    if (
      normalized.includes(`${sep}.snapshot-batch-staging${sep}`)
      && normalized.includes(`${sep}snapshots${sep}`)
      && normalized.endsWith(".json")
    ) {
      stagedMembers += 1;
      if (stagedMembers === 1) process.exit(71);
    }
    return result;
  };
  syncBuiltinESMExports();
}

try {
  const store = new PriceSnapshotStore(config.root);
  const result = store.putMany(config.batch);
  process.stdout.write(JSON.stringify({ ok: true, inserted: result.inserted, duplicates: result.duplicates }));
} catch (error) {
  process.stderr.write(JSON.stringify({
    ok: false,
    name: error?.name,
    code: error?.code,
    message: error?.message
  }));
  process.exitCode = 2;
}
