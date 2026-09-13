import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { exportUsage } from "../dist/src/export/index.js";
import { openTokenReader } from "../dist/src/read/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

const EVENT_COUNT=500;

function event(index) {
  const second=index%60;
  const minute=Math.floor(index/60)%60;
  const timestamp=`2026-09-12T10:${String(minute).padStart(2,"0")}:${String(second).padStart(2,"0")}Z`;
  return {
    schema_version:"ai-verse-token/0.1", event_id:`evt_perf_${String(index).padStart(5,"0")}`, request_id:`req-${index}`, session_id:`s-${index%10}`, task_id:`t-${index%20}`,
    source:{runtime:index%2===0?"hermes":"codex",source_type:"perf",source_record_id:`raw-${index}`}, observed_at:timestamp,
    identity:{billing_platform:index%2===0?"openrouter":"openai",inference_provider:"openai",requested_model:"gpt-test",resolved_model:`gpt-test-${index%3}`},
    scope:{workspace_id:`w-${index%5}`,agent_id:`a-${index%4}`},
    usage:{input_tokens:1000+index,output_tokens:100,reasoning_tokens:20,cache_read_tokens:500,cache_write_tokens:0,cached_input_tokens:0,total_tokens_reported:1620+index},
    timing:{wall_ms:1000+(index%100),ttft_ms:100,generation_ms:900},
    provenance:{collector_id:"perf",source_record_fingerprint:`perf-${String(index).padStart(5,"0")}-0123456789`,usage_quality:"provider_reported",timing_quality:"provider_reported",content_stored:false}
  };
}

function elapsed(fn) {
  const start=performance.now();
  const value=fn();
  return {value,ms:performance.now()-start};
}

test("read surfaces stay within generous first-release performance ceilings", () => {
  const dir=mkdtempSync(join(tmpdir(),"ai-verse-token-perf-"));
  const path=join(dir,"token.sqlite");
  try {
    const ledger=openTokenLedger({path});
    for(let i=0;i<EVENT_COUNT;i++) ledger.ingestUsageEvent(event(i));
    ledger.close();

    const opened=elapsed(()=>openTokenReader({path,authorization:{principal_id:"test-owner",mode:"owner"}}));
    assert.ok(opened.ms < 5000,`read-only open ${opened.ms.toFixed(1)}ms exceeded 5000ms`);
    const reader=opened.value;

    const query=elapsed(()=>reader.query({limit:500}));
    assert.equal(query.value.events.length,EVENT_COUNT);
    assert.ok(query.ms < 5000,`query ${query.ms.toFixed(1)}ms exceeded 5000ms`);

    const aggregate=elapsed(()=>reader.aggregate({groupBy:["resolved_model","workspace_id"],metrics:[{operator:"count"},{operator:"sum",field:"input_tokens"}],limit:100}));
    assert.ok(aggregate.value.rows.length > 0);
    assert.ok(aggregate.ms < 5000,`aggregate ${aggregate.ms.toFixed(1)}ms exceeded 5000ms`);

    const analysis=elapsed(()=>reader.time({max_events:EVENT_COUNT,bucket:"session"}));
    assert.equal(analysis.value.event_count,EVENT_COUNT);
    assert.ok(analysis.ms < 10_000,`time analysis ${analysis.ms.toFixed(1)}ms exceeded 10000ms`);

    const exported=elapsed(()=>exportUsage(reader,{format:"csv",max_events:EVENT_COUNT}));
    assert.match(exported.value,/evt_perf_00499/);
    assert.ok(exported.ms < 10_000,`CSV export ${exported.ms.toFixed(1)}ms exceeded 10000ms`);
    reader.close();
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
