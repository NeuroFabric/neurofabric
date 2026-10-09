interface IngestionMetrics {
  rawEventsReceived: number;
  rawEventsWindow: Array<{ timestamp: number; count: number }>;
  rawBytesReceived: number;
  rawBytesWindow: Array<{ timestamp: number; bytes: number }>;
  suppressedAlertsCount: number;
  dlpSecretsScrubbedCount: number;
  ingestLatencies: number[];
  sourceDistribution: Record<string, number>;
  severityDistribution: Record<'critical' | 'warning' | 'info', number>;
}

interface MetricsSnapshot {
  eps: number;
  throughputKBps: number;
  suppressionRatio: number;
  avgLatencyMs: number;
  dlpCount: number;
  topSources: Array<{ source: string; count: number }>;
  severities: Record<'critical' | 'warning' | 'info', number>;
}

export class MetricsCollector {
  private metrics: IngestionMetrics;
  private windowMs: number = 60000; // 60 second window

  constructor() {
    this.metrics = {
      rawEventsReceived: 0,
      rawEventsWindow: [],
      rawBytesReceived: 0,
      rawBytesWindow: [],
      suppressedAlertsCount: 0,
      dlpSecretsScrubbedCount: 0,
      ingestLatencies: [],
      sourceDistribution: {},
      severityDistribution: { critical: 0, warning: 0, info: 0 }
    };
  }

  private cleanupOldEntries(currentTime: number): void {
    const cutoff = currentTime - this.windowMs;
    
    // Cleanup events window
    this.metrics.rawEventsWindow = this.metrics.rawEventsWindow.filter(
      entry => entry.timestamp > cutoff
    );
    
    // Cleanup bytes window
    this.metrics.rawBytesWindow = this.metrics.rawBytesWindow.filter(
      entry => entry.timestamp > cutoff
    );
  }

  recordIngest(sizeBytes: number, latencyMs: number, severity: string, source: string, secretsFound: number): void {
    const now = Date.now();
    
    // Update total counters
    this.metrics.rawEventsReceived++;
    this.metrics.rawBytesReceived += sizeBytes;
    
    // Update sliding windows
    this.cleanupOldEntries(now);
    
    this.metrics.rawEventsWindow.push({ timestamp: now, count: 1 });
    this.metrics.rawBytesWindow.push({ timestamp: now, bytes: sizeBytes });
    
    // Update DLP count
    this.metrics.dlpSecretsScrubbedCount += secretsFound;
    
    // Update ingest latencies (keep last 100)
    this.metrics.ingestLatencies.push(latencyMs);
    if (this.metrics.ingestLatencies.length > 100) {
      this.metrics.ingestLatencies.shift();
    }
    
    // Update source distribution
    this.metrics.sourceDistribution[source] = (this.metrics.sourceDistribution[source] || 0) + 1;
    
    // Update severity distribution
    const normalizedSeverity = this.normalizeSeverity(severity);
    this.metrics.severityDistribution[normalizedSeverity]++;
  }

  recordSuppression(): void {
    this.metrics.suppressedAlertsCount++;
  }

  private normalizeSeverity(severity: string): 'critical' | 'warning' | 'info' {
    const s = severity.toLowerCase();
    if (s === 'critical' || s === 'error' || s === 'fatal') return 'critical';
    if (s === 'warning' || s === 'warn') return 'warning';
    return 'info';
  }

  getSnapshot(): MetricsSnapshot {
    const now = Date.now();
    this.cleanupOldEntries(now);
    
    // Calculate EPS (events per second)
    const eventsInWindow = this.metrics.rawEventsWindow.reduce((sum, entry) => sum + entry.count, 0);
    const eps = eventsInWindow / 60;
    
    // Calculate throughput (KB/s)
    const bytesInWindow = this.metrics.rawBytesWindow.reduce((sum, entry) => sum + entry.bytes, 0);
    const throughputKBps = (bytesInWindow / 1024) / 60;
    
    // Calculate suppression ratio
    const totalEvents = eventsInWindow + this.metrics.suppressedAlertsCount;
    const suppressionRatio = totalEvents > 0 ? this.metrics.suppressedAlertsCount / totalEvents : 0;
    
    // Calculate average latency
    const avgLatencyMs = this.metrics.ingestLatencies.length > 0
      ? this.metrics.ingestLatencies.reduce((sum, lat) => sum + lat, 0) / this.metrics.ingestLatencies.length
      : 0;
    
    // Get top sources
    const topSources = Object.entries(this.metrics.sourceDistribution)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([source, count]) => ({ source, count }));
    
    return {
      eps: Math.round(eps * 100) / 100,
      throughputKBps: Math.round(throughputKBps * 100) / 100,
      suppressionRatio: Math.round(suppressionRatio * 10000) / 100,
      avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
      dlpCount: this.metrics.dlpSecretsScrubbedCount,
      topSources,
      severities: { ...this.metrics.severityDistribution }
    };
  }

  reset(): void {
    this.metrics = {
      rawEventsReceived: 0,
      rawEventsWindow: [],
      rawBytesReceived: 0,
      rawBytesWindow: [],
      suppressedAlertsCount: 0,
      dlpSecretsScrubbedCount: 0,
      ingestLatencies: [],
      sourceDistribution: {},
      severityDistribution: { critical: 0, warning: 0, info: 0 }
    };
  }
}

// Export singleton instance
export const metricsCollector = new MetricsCollector();
