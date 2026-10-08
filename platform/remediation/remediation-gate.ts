import type { AsyncApprovalGate } from "../embassy/async-approval.ts";
import type { ApprovalSubject } from "../embassy/elicitation.ts";
import {
  proposeInfrastructurePatch,
  readProposedPatch,
  type PatchRequest,
  type PatchTarget,
  type RemediationFormat,
} from "./iac-generator.ts";

/**
 * THE HITL WIRING.
 *
 * This is the composition root where remediation meets the
 * approval gate fixed in Phase 9, and it is where the
 * pipeline HALTS.
 *
 * The shape of the halt, stated plainly:
 *
 *   request  -> the patch is written to the sandbox and the
 *               gate is BEGUN. The pipeline is now in
 *               AWAITING_APPROVAL and goes nowhere else.
 *   review   -> an Incident Commander settles the gate.
 *   release  -> ONLY an approved task releases anything, and
 *               what it releases is the DOCUMENT, for an
 *               operator to run. There is no fourth step.
 *               There is no apply. The engine that could
 *               apply does not exist in this process.
 */

/** The alert that triggers a remediation proposal. */
export interface RemediationAlert {
  /** Where the alert came from: the provider name in the verdict. */
  readonly provider: string;
  /** The alert text. It names the resource, in its first word. */
  readonly text: string;
  /** When it fired. Provenance for the document. */
  readonly at: string;
};

/** What `request` returns: a proposal the pipeline is now waiting on. */
export interface RemediationProposal {
  readonly status: "AWAITING_APPROVAL";
  readonly patchId: string;
  readonly format: RemediationFormat;
  /** Absolute path of the patch document, inside the sandbox. */
  readonly path: string;
  readonly document: string;
  /** The token the verdict will arrive with. */
  readonly taskToken: string;
  /** When the approval window closes. */
  readonly expiresAt: string;
}

/**
 * What `release` returns.
 *
 * BLOCKED is not an error to retry around: it is the system
 * doing its job. A blocked release means no human approved
 * the patch, so no patch moved.
 */
export type ReleaseOutcome =
  | {
      readonly status: "BLOCKED";
      readonly reason: string;
    }
  | {
      readonly status: "RELEASED";
      readonly patchId: string;
      /** The document, for the operator to run. Nothing was run. */
      readonly document: string;
      readonly approvedBy: string | undefined;
      readonly decidedAt: number;
    };

/**
 * The controller the Conductor holds. An interface, because the
 * Conductor must not know where patches come from -- only that
 * they arrive halted, with a token an operator can be asked about.
 */
export interface RemediationController {
  request(alert: RemediationAlert): Promise<RemediationProposal>;
  /** An Incident Commander settles a pending proposal. */
  review(
    taskToken: string,
    decision: { readonly approved: boolean; readonly approvedBy: string; readonly reason: string },
  ): void;
  /** The only path to a patch document, and it demands an approval. */
  release(taskToken: string): Promise<ReleaseOutcome>;
}

/**
 * THE DERIVATION.
 *
 * Deliberately small and deterministic. The alert's first word
 * names the workload; the remediation proposed is a scale-out.
 * Everything more ambitious waits for a human to widen it, and
 * that is a feature: a generator that invents infrastructure
 * changes from free text is a generator that invents them wrong,
 * and the human in the loop is the control that catches it.
 */
const PROPOSED_REPLICAS = 3;

export function deriveRemediation(alert: RemediationAlert): PatchRequest {
  const first = alert.text.trim().split(/\s+/)[0] ?? "workload";
  const cleaned = first.replace(/[^A-Za-z0-9/-]/g, "");
  const name = /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(cleaned) ? cleaned : "workload";
  const target: PatchTarget = {
    kind: "Deployment",
    resource: name,
    provider: alert.provider,
    alertText: alert.text,
  };
  return {
    target,
    format: "kubernetes",
    desiredState: { replicas: PROPOSED_REPLICAS },
  };
}

export interface RemediationServiceOptions {
  /** The Phase 9 gate. A patch cannot move without it. */
  readonly gate: AsyncApprovalGate;
  /** The sandbox the patch is written into. */
  readonly sandboxRoot: string;
  /** The tenant the approval is recorded under. */
  readonly tenant: string;
}

export class RemediationService implements RemediationController {
  // `options` is a plain field rather than a constructor parameter
  // property: the test runner strips types only, and a parameter
  // property is not erasable by stripping alone.
  private readonly options: RemediationServiceOptions;

  constructor(options: RemediationServiceOptions) {
    this.options = options;
  }

  async request(alert: RemediationAlert): Promise<RemediationProposal> {
    const proposal = await proposeInfrastructurePatch(
      deriveRemediation(alert),
      this.options.sandboxRoot,
    );

    /**
     * THE SUBJECT THE OPERATOR IS ASKED ABOUT.
     *
     * The patch id rides as the credentialName -- it is the
     * reference the decision is ABOUT, not a value anyone is
     * handed. Exposure is "reference" on purpose: the operator
     * approves the patch document, and the document is read
     * from the sandbox only after the approval exists.
     */
    const subject: ApprovalSubject = {
      tool: "propose_infrastructure_patch",
      tenant: this.options.tenant,
      capability: "remediation:infrastructure",
      credentialName: proposal.patchId,
      exposure: "reference",
      sideEffects: [
        "writes one patch document into the remediation sandbox",
        "applies nothing: the patch is a document for an operator to run",
      ],
    };

    const required = this.options.gate.begin(subject);

    return {
      status: "AWAITING_APPROVAL",
      patchId: proposal.patchId,
      format: proposal.format,
      path: proposal.path,
      document: proposal.document,
      taskToken: required.taskToken,
      expiresAt: required.expiresAt,
    };
  }

  review(
    taskToken: string,
    decision: { approved: boolean; approvedBy: string; reason: string },
  ): void {
    // The subject is readable only while the task is pending,
    // which is exactly when a review happens. On a grant, the
    // patch id is stashed as the held result, so release can
    // be answered from the gate's own record rather than from
    // any memory this service keeps.
    const subject = this.options.gate.subject(taskToken);
    if (subject === undefined) {
      throw new Error("no pending proposal matches that task token");
    }
    this.options.gate.settle(
      taskToken,
      { approved: decision.approved, approvedBy: decision.approvedBy, reason: decision.reason },
      decision.approved ? { value: subject.credentialName } : undefined,
    );
  }

  async release(taskToken: string): Promise<ReleaseOutcome> {
    const approval = this.options.gate.approval(taskToken);
    if (approval === undefined) {
      const status = this.options.gate.status(taskToken);
      return {
        status: "BLOCKED",
        reason: status === undefined
          ? "no proposal matches that task token"
          : `the proposal is ${status}; an Incident Commander must approve it before release`,
      };
    }

    // The patch id is the held result, which is the ONLY
    // way release finds the document: the decision and the
    // patch are joined by the gate's own record.
    const patchId = approval.subject.credentialName;
    const document = await readProposedPatch(patchId, this.options.sandboxRoot);
    return {
      status: "RELEASED",
      patchId,
      document,
      approvedBy: approval.approvedBy,
      decidedAt: approval.decidedAt,
    };
  }
}
