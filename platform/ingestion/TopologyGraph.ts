/**
 * TOPOLOGY CAUSAL GRAPH & CASCADE SUPPRESSOR.
 *
 * Defines a directed dependency map for services and, when a parent/upstream
 * service fails due to an ongoing root cause on a downstream dependency, tags
 * the alert as CASCADING_CORRELATED and increments the suppression counter.
 *
 * Dependency map (service -> list of downstream dependencies):
 *   order-service    -> [ inventory-db, payment-service ]
 *   auth-gateway     -> [ redis-cluster ]
 *   k8s-ingress      -> [ order-service, auth-gateway ]
 */

// ---------------------------------------------------------------------------
// Dependency map: service -> downstream services
// ---------------------------------------------------------------------------
const dependencyMap: Record<string, string[]> = {
  "order-service": ["inventory-db", "payment-service"],
  "auth-gateway": ["redis-cluster"],
  "k8s-ingress": ["order-service", "auth-gateway"],
};

// Reverse map: downstream -> list of upstream services (computed on demand)
function computeReverseMap(): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  for (const [source, targets] of Object.entries(dependencyMap)) {
    for (const target of targets) {
      if (!reverse[target]) reverse[target] = [];
      reverse[target].push(source);
    }
  }
  return reverse;
}

export class TopologyGraph {
  private readonly forwardMap: Record<string, string[]>;
  private readonly reverseMap: Record<string, string[]>;
  private cascadeCounter: number = 0;

  constructor() {
    this.forwardMap = { ...dependencyMap };
    this.reverseMap = computeReverseMap();
  }

  /**
   * Get the downstream dependencies of a service.
   * Returns an empty array if the service is not in the map.
   */
  getDownstreams(service: string): string[] {
    return this.forwardMap[service] || [];
  }

  /**
   * Get the upstream (parent) services that depend on this service.
   */
  getUpservices(service: string): string[] {
    return this.reverseMap[service] || [];
  }

  /**
   * Tag an alert as CASCADING_CORRELATED if the alert's service is a downstream
   * dependency of a service that already has an ongoing root cause.
   * Increments the internal cascade counter.
   */
  tagCascadingCorrelated(service: string, upstreamService: string): {
    tagged: boolean;
    cascadeCounter: number;
  } {
    const downstreams = this.getDownstreams(upstreamService);
    const tagged = downstreams.includes(service);

    if (tagged) {
      this.cascadeCounter++;
    }

    return { tagged, cascadeCounter: this.cascadeCounter };
  }

  /**
   * Get the current cascade suppression counter value.
   */
  getCascadeCounter(): number {
    return this.cascadeCounter;
  }

  /**
   * Reset the cascade counter (useful for test suite teardown).
   */
  resetCascadeCounter(): void {
    this.cascadeCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// Export a singleton instance for immediate use by the ingestion pipeline
// ---------------------------------------------------------------------------
export const topologyGraph = new TopologyGraph();

// ---------------------------------------------------------------------------
// Helper: annotate an alert event using the topology graph
// ---------------------------------------------------------------------------
export function annotateAlert(
  service: string,
  upstreamService?: string,
): { status: string; cascadeCounter: number } {
  const { tagged, cascadeCounter } = topologyGraph.tagCascadingCorrelated(
    service,
    upstreamService || "",
  );

  const status = tagged ? "CASCADING_CORRELATED" : "normal";
  return { status, cascadeCounter };
}
