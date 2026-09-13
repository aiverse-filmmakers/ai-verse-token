import assert from "node:assert/strict";
import test from "node:test";
import { analyzeEfficiency, evaluateBudget, evaluateQuotaWindows } from "../dist/src/efficiency/index.js";

function event({
  id, session="s1", task="t1", model="m1", input=100, output=20, reasoning=0,
  cacheRead=0, cachedInput=0, cacheWrite=0, total, wall=1000, start, end, workspace="w1"
}) {
  const usage = {
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
    ...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
    ...(cachedInput === undefined ? {} : { cached_input_tokens: cachedInput }),
    ...(total === undefined ? {} : { total_tokens_reported: total })
  };
  return {
    schema_version:"ai-verse-token/0.1", event_id:id, request_id:id, session_id:session, task_id:task,
    source:{runtime:"test",source_type:"test",source_record_id:id}, observed_at:"2026-09-12T10:00:00Z",
    identity:{billing_platform:"openai",inference_provider:"openai",requested_model:model,resolved_model:model},
    scope:{workspace_id:workspace}, usage,
    timing:{...(wall === undefined ? {} : {wall_ms:wall}), ...(start?{started_at:start}:{}), ...(end?{ended_at:end}:{})},
    provenance:{collector_id:"test",source_record_fingerprint:`${id}abcdef0123456789`,usage_quality:"provider_reported",timing_quality:"provider_reported",content_stored:false}
  };
}

const actual = (id, amount, currency="USD") => ({status:"ACTUAL",event_id:id,amount,currency,actual_charge:{amount:String(amount),currency,source:"provider_reported"}});
const calculated = (id, amount, currency="USD") => ({status:"CALCULATED",event_id:id,amount,currency,event_time:"2026-09-12T10:00:00Z",price_snapshot_id:"p",pricing_source_id:"s",components:[]});

test("efficiency computes complete cache and reasoning ratios without conflating categories", () => {
  const result = analyzeEfficiency({events:[event({id:"e1",input:100,cacheRead:300,output:80,reasoning:20,total:500})]});
  assert.equal(result.overall.cache_read_ratio.value, 0.75);
  assert.equal(result.overall.reasoning_share.value, 0.2);
  assert.equal(result.overall.total_tokens.known_lower_bound, "500");
  assert.equal(result.overall.total_tokens.complete, true);
});

test("ratio becomes unknown when a required category is absent instead of assuming zero", () => {
  const result = analyzeEfficiency({events:[event({id:"e2",cacheRead:null,cachedInput:null,total:120})]});
  assert.equal(result.overall.cache_read_ratio.value, null);
  assert.equal(result.overall.cache_read_ratio.complete, false);
});

test("cost coverage keeps currencies and ACTUAL/CALCULATED truth separate", () => {
  const events=[event({id:"e3"}),event({id:"e4"}),event({id:"e5"})];
  const result=analyzeEfficiency({events,costs:[actual("e3","1.1"),calculated("e4","2.25"),actual("e5","3","EUR")]});
  assert.deepEqual(result.overall.costs.by_currency,[
    {currency:"EUR",actual:"3",calculated:"0",known_total:"3"},
    {currency:"USD",actual:"1.1",calculated:"2.25",known_total:"3.35"}
  ]);
});

test("grouping supports task/session/model/workspace dimensions without raw SQL", () => {
  const result=analyzeEfficiency({events:[event({id:"e6",task:"a"}),event({id:"e7",task:"b"}),event({id:"e8",task:"a"})],group_by:"task_id"});
  assert.deepEqual(result.groups.map(r=>[r.key,r.metrics.request_count]),[["a",2],["b",1]]);
});

test("retry tax only counts explicit retry links", () => {
  const events=[event({id:"e9",total:120,wall:1000}),event({id:"e10",total:150,wall:2000}),event({id:"e11",total:180,wall:3000})];
  const result=analyzeEfficiency({events,costs:[actual("e10","0.5")],retry_links:[{retry_event_id:"e10",original_event_id:"e9"}]});
  assert.equal(result.retry_tax.retry_request_count,1);
  assert.equal(result.retry_tax.total_tokens.known_lower_bound,"150");
  assert.equal(result.retry_tax.compute_ms_known,2000);
  assert.equal(result.retry_tax.costs.by_currency[0].known_total,"0.5");
});

test("retry links fail closed on unknown events, duplicates and cycles", () => {
  const events=[event({id:"e12"}),event({id:"e13"})];
  assert.throws(()=>analyzeEfficiency({events,retry_links:[{retry_event_id:"missing",original_event_id:"e12"}]}));
  assert.throws(()=>analyzeEfficiency({events,retry_links:[{retry_event_id:"e13",original_event_id:"e12"},{retry_event_id:"e13",original_event_id:"e12"}]}));
  assert.throws(()=>analyzeEfficiency({events,retry_links:[{retry_event_id:"e13",original_event_id:"e12"},{retry_event_id:"e12",original_event_id:"e13"}]}));
});

test("token budget is UNKNOWN when only a lower bound is known", () => {
  const events=[event({id:"e14",total:80_000_000}),event({id:"e15",input:1,output:null,reasoning:null,cacheRead:null,cachedInput:undefined,cacheWrite:undefined,total:undefined})];
  const result=evaluateBudget(events,[],{budget_id:"tokens",metric:"total_tokens",limit:"100000000"});
  assert.equal(result.state,"UNKNOWN");
  assert.equal(result.known_used,"80000001");
  assert.equal(result.remaining_if_complete,null);
  assert.equal(result.unknown_event_count,1);
});

test("known lower bound can safely EXCEED a token budget despite unknown events", () => {
  const events=[event({id:"e16",total:110_000_000}),event({id:"e17",output:null,reasoning:null,cacheRead:null,cachedInput:undefined,cacheWrite:undefined,total:undefined})];
  const result=evaluateBudget(events,[],{budget_id:"tokens",metric:"total_tokens",limit:"100000000"});
  assert.equal(result.state,"EXCEEDED");
  assert.equal(result.complete,false);
});

test("cost budget never mixes currencies and can exclude CALCULATED cost", () => {
  const events=[event({id:"e18"}),event({id:"e19"}),event({id:"e20"})];
  const costs=[actual("e18","4","USD"),calculated("e19","5","USD"),actual("e20","99","EUR")];
  const all=evaluateBudget(events,costs,{budget_id:"usd",metric:"cost",limit:"10",currency:"USD"});
  assert.equal(all.known_used,"9");
  assert.equal(all.state,"UNKNOWN");
  assert.equal(all.unknown_event_count,1);
  const exact=evaluateBudget([event({id:"e18x"})],[actual("e18x","0.2")],{budget_id:"exact",metric:"cost",limit:"0.3",currency:"USD"});
  assert.equal(exact.remaining_if_complete,"0.1");
  const actualOnly=evaluateBudget(events,costs,{budget_id:"actual-usd",metric:"cost",limit:"3",currency:"USD",include_calculated:false});
  assert.equal(actualOnly.known_used,"4");
  assert.equal(actualOnly.state,"EXCEEDED");
});

test("compute budget uses known duration lower bound and remains UNKNOWN with missing timing", () => {
  const events=[event({id:"e21",wall:800}),event({id:"e22",wall:null})];
  const result=evaluateBudget(events,[],{budget_id:"compute",metric:"compute_ms",limit:"1000"});
  assert.equal(result.known_used,"800");
  assert.equal(result.state,"UNKNOWN");
});

test("active wall budget uses interval union instead of summed parallel duration", () => {
  const events=[
    event({id:"e23",wall:undefined,start:"2026-09-12T10:00:00Z",end:"2026-09-12T10:00:10Z"}),
    event({id:"e24",wall:undefined,start:"2026-09-12T10:00:05Z",end:"2026-09-12T10:00:15Z"})
  ];
  const active=evaluateBudget(events,[],{budget_id:"active",metric:"active_wall_ms",limit:"20000"});
  const compute=evaluateBudget(events,[],{budget_id:"compute",metric:"compute_ms",limit:"25000"});
  assert.equal(active.known_used,"15000");
  assert.equal(active.state,"OK");
  assert.equal(compute.known_used,"20000");
  assert.equal(compute.state,"WARNING");
});

test("quota windows expose remaining, utilization, warning and exhaustion", () => {
  const rows=evaluateQuotaWindows({observed_at:"2026-09-12T12:00:00Z",windows:[
    {kind:"five_hour",used:4,limit:10,resets_at:"2026-09-12T15:00:00Z"},
    {kind:"weekly",used:8,limit:10,resets_at:null},
    {kind:"monthly",used:11,limit:10,resets_at:null}
  ]});
  assert.deepEqual(rows.map(r=>[r.kind,r.state,r.remaining]),[["five_hour","OK",6],["weekly","WARNING",2],["monthly","EXCEEDED",0]]);
});

test("efficiency exact integer accumulation survives totals above Number.MAX_SAFE_INTEGER", () => {
  const max=Number.MAX_SAFE_INTEGER;
  const result=analyzeEfficiency({events:[event({id:"e25",total:max}),event({id:"e26",total:max})]});
  assert.equal(result.overall.total_tokens.known_lower_bound,(BigInt(max)*2n).toString());
});
