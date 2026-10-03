from pathlib import Path

path = Path("src/pricing/store.ts")
text = path.read_text(encoding="utf-8")
old = '''    const directory = join(this.#stateDir, sha256(sourceId));
    if (!nodeExists(directory)) return undefined;
    const directoryInfo = lstatSync(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `unsafe sync-state directory: ${directory}`);
    }
    let latest: PricingSyncState | undefined;
    let latestName = "";
    const entries = readdirSync(directory).sort();
    if (entries.length > MAX_STORE_ENTRIES) throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "sync-state directory exceeds supported entry count");'''
new = '''    const directory = join(this.#stateDir, sha256(sourceId));
    let entries: string[] = [];
    if (nodeExists(directory)) {
      const directoryInfo = lstatSync(directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `unsafe sync-state directory: ${directory}`);
      }
      entries = readdirSync(directory).sort();
      if (entries.length > MAX_STORE_ENTRIES) throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "sync-state directory exceeds supported entry count");
    }
    let latest: PricingSyncState | undefined;
    let latestName = "";'''
if text.count(old) != 1:
    raise SystemExit(f"sync-state readback anchor: expected 1 match, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
