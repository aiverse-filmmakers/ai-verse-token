import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReadOnlyMcpSurface } from "../dist/src/mcp/index.js";
import { exportUsage } from "../dist/src/export/index.js";
import { openTokenReader } from "../dist/src/read/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function usageEvent(id, overrides={}) {
  return {
    schema_version:"ai-verse-token/0.1",
    event_id:id, request_id:id, session_id:"session-1", task_id:"task-1",
    source:{runtime:"hermes",runtime_version:"1.2.3",source_type:"test",source_record_id:`raw-${id}`},
    observed_at:overrides.observed_at ?? "2026-09-12T10:00:00Z",
    identity:{billing_platform:"openrouter",inference_provider:"openai",requested_model:"auto",resolved_model:"gpt-test"},
    scope:{workspace_id:"workspace-1",agent_id:"agent-1"},
    usage:{input_tokens:100,output_tokens:20,reasoning_tokens:5,cache_read_tokens:50,cache_write_tokens:0,cached_input_tokens:0,total_tokens_reported:175},
    timing:{wall_ms:1000,ttft_ms:100,generation_ms:900},
    ...(overrides.actual_charge ? {actual_charge:overrides.actual_charge}:{}),
    provenance:{collector_id:"test",collector_version:"0.1",source_record_fingerprint:`fingerprint-${id}-0123456789`,usage_quality:"provider_reported",timing_quality:"provider_reported",content_stored:false}
  };
}

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"ai-verse-token-read-"));
  const path=join(dir,"token.sqlite");
  const ledger=openTokenLedger({path});
  ledger.ingestUsageEvent(usageEvent("evt_read_1", {actual_charge:{amount:"0.25",currency:"USD",source:"provider_reported",external_charge_id:"charge-1"}}));
  ledger.ingestUsageEvent(usageEvent("evt_read_2", {observed_at:"2026-09-12T10:01:00Z"}));
  ledger.close();
  return {dir,path,cleanup(){rmSync(dir,{recursive:true,force:true});}};
}

test("TokenReader exposes stable read-only query, aggregate and summary surfaces", () => {
  const f=fixture();
  try {
    const reader=openTokenReader({path:f.path,authorization:{principal_id:"test-owner",mode:"owner"}});
    const page=reader.query({limit:1,order:"asc"});
    assert.equal(page.events.length,1);
    assert.equal(page.hasMore,true);
    const summary=reader.summary();
    assert.equal(summary.request_count,2);
    assert.equal(summary.input_tokens,200);
    assert.equal(summary.total_tokens_reported,350);
    const aggregate=reader.aggregate({groupBy:["resolved_model"],metrics:[{operator:"count"}]});
    assert.equal(aggregate.rows[0].metrics.count,2);
    reader.close();
    assert.throws(()=>reader.query(), error=>error?.code === "READ_CLOSED");
  } finally { f.cleanup(); }
});

test("bounded time and efficiency reads fail closed when max_events is exceeded", () => {
  const f=fixture();
  try {
    const reader=openTokenReader({path:f.path,authorization:{principal_id:"test-owner",mode:"owner"}});
    assert.throws(()=>reader.time({max_events:1}), error=>error?.code === "READ_LIMIT_EXCEEDED");
    const efficiency=reader.efficiency({max_events:2,group_by:"resolved_model"});
    assert.equal(efficiency.event_count,2);
    assert.equal(efficiency.cost_scope,"actual_calculated_unknown");
    assert.equal(efficiency.analysis.overall.costs.actual_event_count,1);
    assert.equal(efficiency.analysis.overall.costs.unknown_event_count,1);
    reader.close();
  } finally { f.cleanup(); }
});

test("JSON export is privacy-safe by default and raw provenance IDs require explicit opt-in", () => {
  const f=fixture();
  try {
    const reader=openTokenReader({path:f.path,authorization:{principal_id:"test-owner",mode:"owner"}});
    const safe=JSON.parse(exportUsage(reader,{format:"json",exported_at:"2026-09-12T12:00:00Z"}));
    assert.equal(safe.schema_version,"ai-verse-token-export/0.1");
    assert.equal(safe.event_count,2);
    assert.equal("source_record_id" in safe.events[0].source,false);
    assert.equal("source_record_fingerprint" in safe.events[0].provenance,false);
    assert.equal("external_charge_id" in safe.events[0].actual_charge,false);
    const raw=JSON.parse(exportUsage(reader,{format:"json",include_provenance_ids:true,exported_at:"2026-09-12T12:00:00Z"}));
    assert.equal(raw.events[0].source.source_record_id,"raw-evt_read_1");
    assert.match(raw.events[0].provenance.source_record_fingerprint,/fingerprint/);
    assert.equal(raw.events[0].actual_charge.external_charge_id,"charge-1");
    reader.close();
  } finally { f.cleanup(); }
});

test("CSV export uses fixed telemetry columns and never exports fingerprints or source record IDs", () => {
  const f=fixture();
  try {
    const reader=openTokenReader({path:f.path,authorization:{principal_id:"test-owner",mode:"owner"}});
    const csv=exportUsage(reader,{format:"csv"});
    assert.match(csv,/event_id,observed_at/);
    assert.match(csv,/evt_read_1/);
    assert.doesNotMatch(csv,/source_record_fingerprint|fingerprint-|raw-evt/);
    reader.close();
  } finally { f.cleanup(); }
});

test("export ceiling prevents accidental unbounded dumps", () => {
  const f=fixture();
  try {
    const reader=openTokenReader({path:f.path,authorization:{principal_id:"test-owner",mode:"owner"}});
    assert.throws(()=>exportUsage(reader,{format:"json",max_events:1}),/exceeds max_events=1/);
    reader.close();
  } finally { f.cleanup(); }
});

test("read-only MCP surface exposes only bounded read tools and privacy-safe events", () => {
  const f=fixture();
  try {
    const reader=openTokenReader({path:f.path,authorization:{principal_id:"test-owner",mode:"owner"}});
    const mcp=createReadOnlyMcpSurface(reader);
    assert.ok(mcp.tools.length >= 5);
    assert.equal(mcp.tools.every(tool=>tool.read_only),true);
    const result=mcp.call("token_usage_query",{limit:2});
    assert.equal(result.events.length,2);
    assert.equal("source_record_fingerprint" in result.events[0].provenance,false);
    const charged = result.events.find((event) => event.actual_charge);
    assert.ok(charged);
    assert.equal("external_charge_id" in charged.actual_charge,false);
    assert.throws(()=>mcp.call("token_usage_query",{limit:101}),/1\.\.100/);
    assert.throws(()=>mcp.call("token_usage_time",{max_events:5001}),/1\.\.5000/);
    assert.throws(()=>mcp.call("token_summary",{sql:"DROP TABLE usage_events"}),/Unsupported MCP argument/);
    reader.close();
  } finally { f.cleanup(); }
});

test("CLI summary/query/export work against a read-only ledger with JSON-safe defaults", () => {
  const f=fixture();
  const cli=fileURLToPath(new URL("../bin/ai-verse-token.mjs", import.meta.url));
  try {
    const summary=JSON.parse(execFileSync(process.execPath,[cli,"summary","--db",f.path,"--json"],{encoding:"utf8"}));
    assert.equal(summary.request_count,2);
    const query=JSON.parse(execFileSync(process.execPath,[cli,"query","--db",f.path,"--limit","1","--json"],{encoding:"utf8"}));
    assert.equal(query.events.length,1);
    assert.equal("source_record_fingerprint" in query.events[0].provenance,false);
    const csv=execFileSync(process.execPath,[cli,"export","--db",f.path,"--format","csv"],{encoding:"utf8"});
    assert.match(csv,/evt_read_1/);
    const bad=spawnSync(process.execPath,[cli,"summary"],{encoding:"utf8"});
    assert.equal(bad.status,2);
    assert.match(bad.stderr,/--db is required/);
  } finally { f.cleanup(); }
});
