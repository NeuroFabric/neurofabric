# Story [1.1]: Deepen Embassy Module for Self-Healing AIOps — Implementation Steps

**type:** feat
**risk:** P1
**context:** infra
**Context**: This story deepens the Embassy module from a shallow JSON-RPC pass-through to a deep Self-Healing AIOps engine that autonomously executes high-confidence remediations, routes low-confidence proposals to Human-in-the-Loop (HITL), and automatically rolls back on telemetry degradation. The deepening improves testability and AI-navigability by providing a high-leverage interface with clear seams and adapters.

## Steps

1. Define TypeScript interfaces for Embassy, RemediationProposal, RemediationOptions, RemediationOutcome, and adapter ports → verify: `ls platform/embassy/engine.ts`
2. Implement Embassy class with constructor injection for adapters and dependencies → verify: `grep -r "class Embassy" platform/embassy/engine.ts`
3. Implement the remediate method with confidence assessment, adapter selection, execution, telemetry monitoring, and automatic rollback → verify: `grep -r "async remediate" platform/embassy/engine.ts`
4. Add default implementations for confidence scorer, telemetry monitor, and logger → verify: `grep -r "defaultConfidenceScorer\|defaultTelemetryMonitor\|defaultLogger" platform/embassy/engine.ts`
5. Export EmbassyInterface for type safety → verify: `grep -r "EmbassyInterface" platform/embassy/engine.ts`

## Verification Script (Step-by-Step)

1. Open the file `platform/embassy/engine.ts` in an editor.
2. Verify that the TypeScript interfaces (Embassy, RemediationProposal, RemediationOptions, RemediationOutcome, etc.) are defined.
3. Verify that the Embassy class is present and implements EmbassyInterface.
4. Verify that the remediate method follows the execution protocol.
5. Verify that default implementations exist and can be overridden.
6. Run the TypeScript compiler to ensure no syntax errors: `npx tsc --noEmit --skipLibCheck platform/embassy/engine.ts`

## Out of scope

- Changes to the existing JSON-RPC HITL adapter implementation.
- Changes to the Autonomous Deployment adapter implementation.
- Updates to the tech-stack documentation (will be handled in a separate story).
- Import-boundary hygiene updates (will be handled in a separate story).

## Risks

- Incorrect confidence scoring could lead to inappropriate autonomous actions. Mitigation: default confidence scorer returns medium confidence (50) unless overridden.
- Telemetry monitor may not detect degradation in test environments. Mitigation: default telemetry monitor returns "healthy"; tests can inject a mock.
- Adapter interface mismatches between AutonomousDeploymentAdapter and HitlAdapter. Mitigation: both adapters are expected to return ExecutionResult; if HitlAdapter currently returns a different type, an adapter shim may be needed.
