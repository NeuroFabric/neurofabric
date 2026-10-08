import { describe, it } from "node:test";
import assert from "node:assert";
import { ingestTelemetry } from "./ingestion-route.ts";

describe("Telemetry Ingestion Webhook", () => {
  it("normalizes Datadog webhook payload", async () => {
    const payload = {
      source: "datadog",
      alert_id: "abc123",
      title: "High CPU",
      message: "CPU > 90%",
      timestamp: new Date().toISOString(),
      severity: "critical",
      metadata: { host: "server1", ip: "10.0.0.1" }
    };
    
    const result = await ingestTelemetry(payload);
    assert.strictEqual(result.source, "datadog");
    assert.strictEqual(result.severity, "critical");
    assert.ok(result.data.alert_id === "abc123");
    // PII should be sanitized
    assert.ok(!result.data.metadata?.ip);
  });

  it("normalizes Splunk alert payload", async () => {
    const payload = {
      source: "splunk",
      id: "splunk-456",
      title: "Error spike",
      summary: "Errors increased",
      time: new Date().toISOString(),
      severity: "high",
      data: { user_email: "test@example.com", count: 100 }
    };
    
    const result = await ingestTelemetry(payload);
    assert.strictEqual(result.source, "splunk");
    assert.strictEqual(result.severity, "high");
    assert.ok(result.data.id === "splunk-456");
    // PII should be sanitized
    assert.ok(!result.data.data?.user_email);
  });

  it("rejects malformed JSON with 400", async () => {
    const payload = { invalid: "data" };
    await assert.rejects(ingestTelemetry(payload), /Bad Request/);
  });

  it("redacts PII in alert payload", async () => {
    const payload = {
      source: "datadog",
      alert_id: "x",
      title: "test",
      message: "msg",
      timestamp: new Date().toISOString(),
      severity: "info",
      metadata: { token: "secret123", email: "a@b.com" }
    };
    
    const result = await ingestTelemetry(payload);
    assert.ok(!result.data.metadata?.token);
    assert.ok(!result.data.metadata?.email);
  });
});
