---
name: security-audit-skill
version: 3.2.0
description: Autonomous 55-point SecOps, AST diff screening, and Indian statutory compliance (DPDP Act 2023 / Rules 2025, CERT-In Section 70B, MeitY IT Rules 2026, SEBI CSCRF) auditing skill for NeuroFabric.
triggers:
  - security audit
  - scan repository for vulnerabilities
  - verify dpdp cert-in compliance
  - screen gitops patch diff
---

# NeuroFabric Security Audit Skill (security-audit-skill)

## Overview
The security-audit-skill enforces deterministic static and runtime security verification across the NeuroFabric codebase, Ingress Gateway, and Autonomous Embassy (Pi Agent) workspace.

## Execution Gates
1. GATE-01: Agent Skill Manifest Registration (.agents & .pi)
2. GATE-02: Secret & .env Git Hygiene (Control #8 / DPDP Sec 8(5))
3. GATE-03: Zero Sensitive Browser Storage - Volatile RAM Only (Controls #6, #22, #68)
4. GATE-04: Mandatory IAM Directory & 6-Digit TOTP MFA Route Gate (Controls #1, #55)
5. GATE-05: In-Flight Indian PII (Aadhaar, PAN, GSTIN, UPI, +91) & Global Secret DLP (Control #9 / DPDP Rules 2025)
6. GATE-06: Parameterized SQL (? bindings), DOM XSS Blocker, 2MB Upload Allowlist & 300s Webhook Replay Guard (Controls #3, #10, #12, #13, #14, #59)
7. GATE-07: Hardened CORS Allowlist, HSTS Preload, CSP, 120 req/min Rate Limiter & 8s Timeouts (Controls #15, #16, #17, #23, #64)
8. GATE-08: CERT-In Section 70B 6-Hour Incident Packet & SEBI CSCRF CycloneDX SBOM Exporter
