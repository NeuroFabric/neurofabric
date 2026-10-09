import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export default class EventCorrelator {
  /**
   * Aggregates alerts based on source and severity.
   * Returns a payload if it's the first occurrence in the window,
   * otherwise returns null to signify redundant noise.
   */
  async aggregateAlerts(alert: any): Promise<any | null> {
    const fingerprint = `incident:${alert.source}:${alert.severity}`;
    
    // Increment alert count in Redis
    const count = await redis.incr(fingerprint);
    
    // Set expiry if this is the first alert
    if (count === 1) {
      await redis.expire(fingerprint, 300); // 5 minutes TTL
      return { 
        ...alert, 
        incidentId: fingerprint, 
        count: 1,
        firstObserved: true 
      };
    }
    
    // Redundant alert
    return null;
  }
}
