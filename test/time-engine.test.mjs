import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUsageTime, requestTimeMetrics, rollupUsageTime } from "../dist/src/time/index.js";

function event({
  id,
  request = id,
  session = "session-a",
  observed = "2026-09-12T10:00:00Z",
  start,
  first,
  end,
  wall,
  ttft,
  generation,
  output = 100,
  input = 1000,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
  cachedInput = 0
}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    request_id: request,
    session_id: session,
    source: { runtime: "test-runtime", source_type: "test", source_record_id: id },
    observed_at: observed,
    identity: {
      billing_platform: "openai",
      inference_provider: "openai",
      requested_model: "gpt-test",
      resolved_model: "gpt-test"
    },
    usage: {
      input_tokens: input,
      output_tokens: output,
      reasoning_tokens: reasoning,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cached_input_tokens: cachedInput,
      total_tokens_reported: input + output + reasoning + cacheRead + cacheWrite + cachedInput
    },
    timing: {
      ...(start ? { started_at: start } : {}),
      ...(first ? { first_token_at: first } : {}),
      ...(end ? { ended_at: end } : {}),
      ...(wall === undefined ? {} : { wall_ms: wall }),
      ...(ttft === undefined ? {} : { ttft_ms: ttft }),
      ...(generation === undefined ? {} : { generation_ms: generation })
    },
    provenance: {
      collector_id: "time-test",
      collector_version: "0.1.0",
      source_record_fingerprint: `${id}abcdef0123456789`,
      usage_quality: "provider_reported",
      timing_quality: "provider_reported",
      content_stored: false
    }
  };
}

test("request timing derives wall, TTFT, generation and output speed from exact timestamps", () => {
  const metrics = requestTimeMetrics(event({
    id: "evt_time_1",
    start: "2026-09-12T10:00:00.000Z",
    first: "2026-09-12T10:00:00.400Z",
    end: "2026-09-12T10:00:02.400Z",
    output: 100
  }));
  assert.equal(metrics.wall_ms, 2400);
  assert.equal(metrics.wall_source, "timestamps");
  assert.equal(metrics.ttft_ms, 400);
  assert.equal(metrics.generation_ms, 2000);
  assert.equal(metrics.time_per_output_token_ms, 20);
  assert.equal(metrics.output_tokens_per_second, 50);
  assert.deepEqual(metrics.exact_interval, {
    start_ms: Date.parse("2026-09-12T10:00:00.000Z"),
    end_ms: Date.parse("2026-09-12T10:00:02.400Z")
  });
});

test("reported duration remains usable when exact interval timestamps are unavailable", () => {
  const metrics = requestTimeMetrics(event({ id: "evt_time_2", wall: 900, ttft: 100, generation: 800, output: 40 }));
  assert.equal(metrics.wall_ms, 900);
  assert.equal(metrics.wall_source, "reported");
  assert.equal(metrics.ttft_ms, 100);
  assert.equal(metrics.generation_ms, 800);
  assert.equal(metrics.output_tokens_per_second, 50);
  assert.equal(metrics.exact_interval, null);
});

test("missing timing remains unknown instead of becoming zero", () => {
  const metrics = requestTimeMetrics(event({ id: "evt_time_unknown" }));
  assert.equal(metrics.wall_ms, null);
  assert.equal(metrics.ttft_ms, null);
  assert.equal(metrics.generation_ms, null);
  assert.equal(metrics.output_tokens_per_second, null);
  assert.equal(metrics.exact_interval, null);
});

test("parallel requests separate compute time from active wall time and expose concurrency", () => {
  const analysis = analyzeUsageTime([
    event({
      id: "evt_parallel_a",
      observed: "2026-09-12T10:00:10Z",
      start: "2026-09-12T10:00:00Z",
      end: "2026-09-12T10:00:10Z",
      output: 10
    }),
    event({
      id: "evt_parallel_b",
      observed: "2026-09-12T10:00:15Z",
      start: "2026-09-12T10:00:05Z",
      end: "2026-09-12T10:00:15Z",
      output: 10
    })
  ]);
  assert.equal(analysis.summary.compute_ms, 20_000);
  assert.equal(analysis.summary.interval_compute_ms, 20_000);
  assert.equal(analysis.summary.active_wall_ms, 15_000);
  assert.equal(analysis.summary.overlap_ms, 5_000);
  assert.equal(analysis.summary.peak_concurrent_requests, 2);
  assert.equal(analysis.summary.concurrency_factor, 20 / 15);
  assert.equal(analysis.summary.average_concurrency_while_active, 20 / 15);
});

test("sequential exact intervals expose exact idle gaps without arbitrary gap heuristics", () => {
  const analysis = analyzeUsageTime([
    event({ id: "evt_idle_a", start: "2026-09-12T10:00:00Z", end: "2026-09-12T10:00:05Z" }),
    event({ id: "evt_idle_b", start: "2026-09-12T10:00:10Z", end: "2026-09-12T10:00:15Z" })
  ]);
  assert.equal(analysis.summary.active_wall_ms, 10_000);
  assert.equal(analysis.summary.interval_compute_ms, 10_000);
  assert.equal(analysis.summary.idle_ms, 5_000);
  assert.equal(analysis.summary.overlap_ms, 0);
  assert.equal(analysis.summary.peak_concurrent_requests, 1);
});

test("idle time remains unknown when even one request lacks an exact interval", () => {
  const analysis = analyzeUsageTime([
    event({ id: "evt_exact", start: "2026-09-12T10:00:00Z", end: "2026-09-12T10:00:05Z" }),
    event({ id: "evt_reported", wall: 2000 })
  ]);
  assert.equal(analysis.summary.compute_ms, 7000);
  assert.equal(analysis.summary.active_wall_ms, 5000);
  assert.equal(analysis.summary.idle_ms, null);
  assert.equal(analysis.summary.known_compute_request_count, 2);
  assert.equal(analysis.summary.unknown_compute_request_count, 0);
});

test("percentiles use deterministic nearest-rank values and skip unknown samples", () => {
  const analysis = analyzeUsageTime([
    event({ id: "evt_p1", wall: 100, ttft: 10, generation: 100, output: 10 }),
    event({ id: "evt_p2", wall: 200, ttft: 20, generation: 100, output: 20 }),
    event({ id: "evt_p3", wall: 300, ttft: 30, generation: 100, output: 30 }),
    event({ id: "evt_p4" })
  ]);
  assert.equal(analysis.summary.wall_ms_p50, 200);
  assert.equal(analysis.summary.wall_ms_p95, 300);
  assert.equal(analysis.summary.wall_ms_p99, 300);
  assert.equal(analysis.summary.ttft_ms_p50, 20);
  assert.equal(analysis.summary.output_tps_p50, 200);
});

test("hour and day rollups group in UTC and keep token categories separate", () => {
  const events = [
    event({
      id: "evt_h1",
      observed: "2026-09-12T10:10:00Z",
      start: "2026-09-12T10:09:59Z",
      end: "2026-09-12T10:10:01Z",
      input: 100,
      output: 10,
      reasoning: 5,
      cacheRead: 20,
      cacheWrite: 30,
      cachedInput: 40
    }),
    event({
      id: "evt_h2",
      observed: "2026-09-12T11:10:00Z",
      start: "2026-09-12T11:09:59Z",
      end: "2026-09-12T11:10:01Z",
      input: 200,
      output: 20
    })
  ];
  const hours = rollupUsageTime(events, { bucket: "hour" });
  assert.equal(hours.length, 2);
  assert.equal(hours[0].bucket_key, "2026-09-12T10:00Z");
  assert.equal(hours[0].summary.request_count, 1);
  assert.deepEqual(hours[0].tokens, {
    input_tokens: 100,
    output_tokens: 10,
    reasoning_tokens: 5,
    cache_read_tokens: 20,
    cache_write_tokens: 30,
    cached_input_tokens: 40
  });
  const days = rollupUsageTime(events, { bucket: "day" });
  assert.equal(days.length, 1);
  assert.equal(days[0].bucket_key, "2026-09-12");
  assert.equal(days[0].summary.request_count, 2);
  assert.equal(days[0].tokens.input_tokens, 300);
});

test("session rollups preserve explicit null session as its own group", () => {
  const events = [
    event({ id: "evt_s1", session: "session-a", observed: "2026-09-12T10:00:00Z", wall: 100 }),
    event({ id: "evt_s2", session: "session-b", observed: "2026-09-12T10:01:00Z", wall: 200 }),
    event({ id: "evt_s3", session: null, observed: "2026-09-12T10:02:00Z", wall: 300 })
  ];
  const rows = rollupUsageTime(events, { bucket: "session" });
  assert.equal(rows.length, 3);
  const noSession = rows.find((row) => row.bucket_key === null);
  assert.ok(noSession);
  assert.equal(noSession.summary.compute_ms, 300);
});

test("session span uses observation boundaries and is not mislabeled active wall time", () => {
  const analysis = analyzeUsageTime([
    event({
      id: "evt_span_a",
      observed: "2026-09-12T10:00:00Z",
      start: "2026-09-12T10:00:00Z",
      end: "2026-09-12T10:00:01Z"
    }),
    event({
      id: "evt_span_b",
      observed: "2026-09-12T12:00:00Z",
      start: "2026-09-12T11:59:59Z",
      end: "2026-09-12T12:00:00Z"
    })
  ]);
  assert.equal(analysis.summary.session_span_ms, 2 * 60 * 60 * 1000);
  assert.equal(analysis.summary.active_wall_ms, 2000);
  assert.equal(analysis.summary.compute_ms, 2000);
});

test("hour rollups split exact compute/active time across bucket boundaries without duplicating request tokens", () => {
  const rows = rollupUsageTime([
    event({
      id: "evt_cross_hour",
      observed: "2026-09-12T11:00:01Z",
      start: "2026-09-12T10:59:59Z",
      end: "2026-09-12T11:00:01Z",
      input: 50,
      output: 5
    })
  ], { bucket: "hour" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bucket_key, "2026-09-12T10:00Z");
  assert.equal(rows[0].summary.request_count, 1);
  assert.equal(rows[0].summary.compute_ms, 1000);
  assert.equal(rows[0].summary.active_wall_ms, 1000);
  assert.equal(rows[0].tokens.input_tokens, 50);
  assert.equal(rows[1].bucket_key, "2026-09-12T11:00Z");
  assert.equal(rows[1].summary.request_count, 0);
  assert.equal(rows[1].summary.interval_request_count, 1);
  assert.equal(rows[1].summary.compute_ms, 1000);
  assert.equal(rows[1].summary.active_wall_ms, 1000);
  assert.equal(rows[1].tokens.input_tokens, 0);
});

test("rollup token totals remain unknown when any event lacks that category", () => {
  const complete = event({ id: "evt_known_tokens", input: 10, output: 1 });
  const incomplete = event({ id: "evt_unknown_tokens", input: 20, output: 1 });
  delete incomplete.usage.input_tokens;
  const rows = rollupUsageTime([complete, incomplete], { bucket: "day" });
  assert.equal(rows[0].tokens.input_tokens, null);
});

test("rollup token totals use exact decimal strings beyond JavaScript safe integers", () => {
  const rows = rollupUsageTime([
    event({ id: "evt_huge_a", input: 4_000_000_000_000_000, output: 0 }),
    event({ id: "evt_huge_b", input: 4_000_000_000_000_000, output: 0 }),
    event({ id: "evt_huge_c", input: 4_000_000_000_000_000, output: 0 })
  ], { bucket: "day" });
  assert.equal(rows[0].tokens.input_tokens, "12000000000000000");
});

test("zero-duration exact requests still contribute to peak concurrency", () => {
  const instant = "2026-09-12T10:00:00Z";
  const analysis = analyzeUsageTime([
    event({ id: "evt_instant", observed: instant, start: instant, end: instant, input: 1, output: 1 })
  ]);
  assert.equal(analysis.summary.peak_concurrent_requests, 1);
  assert.equal(analysis.summary.active_wall_ms, 0);
  assert.equal(analysis.summary.compute_ms, 0);
});
