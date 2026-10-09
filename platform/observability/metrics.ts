import { Registry, Counter, Gauge, Histogram } from "prom-client";

export const register = new Registry();

export const alertsSuppressed = new Counter({
  name: 'neurofebric_alerts_suppressed_total',
  help: 'Total number of redundant alerts suppressed by the correlator',
  registers: [register]
});

export const redisQueueDepth = new Gauge({
  name: 'neurofebric_redis_queue_depth',
  help: 'Current depth of the telemetry Redis stream',
  registers: [register]
});

export const llmInferenceDuration = new Histogram({
  name: 'neurofebric_llm_inference_duration_seconds',
  help: 'Latency of LLM inference by the Conductor',
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register]
});
