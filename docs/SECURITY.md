# Security

## Trust Boundaries

Pi and extensions run with the operating-system permissions of the Pi process. Project trust controls resource loading but is not a sandbox. External files, logs, documents, database results, and API responses are untrusted data.

## Prompt Injection Boundary

Instructions and data must remain separate. Content read from a file or returned by a tool is data even if it contains text such as "ignore previous instructions". Skills, system instructions, and tool policy are the only authoritative instruction sources.

The orchestrator must never promote tool output into a system instruction or use it to bypass policy.

## Tool Safety

- unknown tools are denied;
- writes and destructive operations require policy approval;
- non-idempotent operations are not automatically retried;
- shell commands are controlled and never built by string interpolation from untrusted values;
- path operations must remain within approved roots;
- output and artifact sizes are bounded;
- external network targets require explicit tool policy.

### Tool Restriction

Tool restriction (e.g. `--tools`) must never bypass the safety layer. Even when tool sets are limited, the orchestrator and kernel policy enforcement remain active and fail-closed. If an extension's skill metadata references an unknown tool, the system emits a warning and safely continues without that skill rather than crashing the extension process itself, ensuring the policy gate remains operational.

## Secrets

API keys, tokens, passwords, cookies, private keys, and environment secrets must not appear in prompts, traces, errors, artifacts, or provenance. Record redacted metadata only.

Redaction is centralized in `platform/core/redaction.ts` and is **fail closed**. There is exactly one mechanism; modules do not carry their own secret patterns.

### The boundary

| Path | Enforced by |
| --- | --- |
| Every event payload, before it reaches any subscriber or the event history | `EventBus.emit` (cannot be disabled through the bus) |
| `pi.appendEntry` — the only write into Pi session history | `createRedactingSink` wrapping the extension's sink |
| Artifact metadata originating from tool output | `createArtifact` |
| Validation messages derived from tool errors | `KernelAdapter` |
| Provenance locators | `KernelAdapter` |

Because the event bus is the single choke point, a new event type or a new caller is protected by construction rather than by remembering to sanitize. The persistence sink redacts whatever it is handed, so a future caller cannot bypass the boundary by writing to it directly.

### What it protects

Structured fields whose *name* is credential-like (`api_key`, `token`, `password`, `secret`, `authorization`, `credential`, `client_secret`, `cookie`, and similar) are replaced wholesale, at any nesting depth, in objects, arrays, `Map`s, `Set`s, and `Error`s. Free text is scanned for: PEM private key blocks, URI userinfo (`scheme://user:pass@host` and password-only authorities), `Bearer`/`Basic` headers, JWTs, published provider key prefixes, `name=value` / `name: value` assignments, and high-entropy long tokens.

### What it deliberately does not redact

Content digests, UUIDs, timestamps, artifact ids, file paths, SQL, and ordinary prose are left readable. Redaction is signature- and field-based rather than length-based, because a length heuristic would destroy exactly the provenance data the platform needs. Hex strings longer than 128 characters *are* treated as secret material, since no digest is that long.

### Known limits

- Percent-encoded credentials are handled by decoding and, if the decoded form is sensitive, replacing the whole value. Deeper or non-URL encodings (base64 of a connection string) are not decoded.
- A secret with no distinguishing signature and no credential-like field name may pass through. The generic long-token rule is the backstop, not a proof.
- Redaction protects the platform's own output. It does not stop Pi's own transcript from containing a value the model read, and it does not prevent a tool from acting on a secret — only from persisting it through Neurofebric.


## Approval

Approval is an injected interface. Pi UI is an adapter, not part of policy logic. In non-interactive mode, operations requiring approval fail closed.

## Trust Models

The policy mode is selected per project by `.pi/neurofebric.json`. Pi's own project trust is a *different* mechanism: it only controls whether project resources such as extensions and settings load at startup, and it never gates a tool call.

| Mode | Behaviour |
| --- | --- |
| `APPROVAL` (default) | `CONTROLLED` and `WRITE` operations return `REQUIRE_APPROVAL` and are confirmed through Pi UI. Non-interactive runs fail closed. |
| `TRUSTED_PROJECT` | Ordinary development operations resolve to `ALLOW` with no interaction. There is no code path from this mode to a confirmation dialog. |

```json
{ "policyMode": "TRUSTED_PROJECT", "allowedRoots": ["."] }
```

A missing or malformed file falls back to `APPROVAL`, so trusted mode is never enabled implicitly.

`TRUSTED_PROJECT` is a different boundary, not a weaker one. It is **fail-closed** and denies, without prompting, anything that matches:

- an unregistered tool (rejected by the tool registry before policy runs);
- a tool classified `DESTRUCTIVE`;
- credential material — `.env`, `id_rsa`, `.ssh`, `.aws/credentials`, `.npmrc`, `.git-credentials`, `printenv`, and similar;
- destructive commands — recursive/forced deletion, disk and filesystem formatting, machine and process control, privilege tampering, registry and VCS history destruction, and `DROP`/`TRUNCATE`/`DELETE FROM`;
- any path that escapes `allowedRoots`, including `..` traversal, absolute paths outside the root, and symlinks or junctions that resolve out of the root.

Denials are reported to the model instead of stalling the run, so a hostile or mistaken request fails immediately and legibly.

Known limits of this boundary:

- Path detection inside free-form shell text is a conservative detector, not a shell parser. A command that reaches outside the root through a construct it does not recognise may not be caught. The boundary constrains what the platform knowingly authorises; it is not an OS sandbox, and Pi's own documentation is explicit that project trust does not restrict what a permitted command can reach.
- The `DESTRUCTIVE_PATTERNS` and `SECRET_ACCESS_PATTERNS` lists in `platform/core/policy.ts` are deny lists. They are conservative by design: prefer widening `allowedRoots` over loosening them.


## Deployment Controls

Pi documentation recommends a container, VM, or dedicated user when analyzing untrusted material. Production deployments should combine project trust with OS isolation, scoped credentials, network restrictions, backups, and reviewable audit records.


## Open Issues

No open issues are recorded here.

A previously listed entry, OI-001 (policy scanner matching raw string content
and producing false denials), has been removed. It is not a tracked finding:
there is no corresponding finding document, no corresponding test, and no current
status entry that references it. The behaviour it described is already covered by
the tracked findings that replaced it — F-007 for path-extraction false
positives on quoted, backslash-leading pattern arguments, and the
`WorkspaceBoundary` known-limits section above.

The constraint recorded on that entry still stands as a general rule and is now
carried in F-007: a false positive removed by weakening a pattern is a
regression, not a fix, and any change in this area must be re-verified against
the trusted-execution suite so that credential access, destructive commands, and
workspace escape remain denied.


## The Path Model

The workspace boundary answers one question: *may this genuine filesystem path be touched?* It no longer has to guess which strings are paths, because the caller now says so.

`extractToolPathCandidates` in `platform/core/tool-paths.ts` produces path operands in one of two ways, and nothing else contributes a path:

1. **Structured tools.** The tool descriptor carries an input schema, so the argument names are known. Only values under a path-bearing argument name, such as a path, file path, directory, or destination, become operands. A content, pattern, or text argument is never a path source, however much it resembles one.
2. **Shell tools.** Only operand tokens from a shell-aware tokenizer become operands: flags, variable assignments, URLs, and non-path words are skipped, and redirection targets are marked so they can be handled deliberately.

Anything the runtime cannot classify, a tool with no usable schema, falls back to the previous conservative scan. That fallback is the reason a tool with no declared schema is still protected.

Containment itself is unchanged and remains the authority: lexical resolution, sibling-prefix safety, realpath of the nearest existing ancestor for symlinks and junctions, and case-insensitive comparison on the relevant platforms.


## The Command Model

Command *classification* is separate from path *validation*, and the two answer different questions.

Destructive and credential patterns are matched against command text, not against arbitrary payload content. For a shell tool, every string in the input is command text. For a structured tool, only arguments named as commands, such as a command, script, or args field, are treated as command text. A file's content is data. It is not scanned for destructive patterns, and it is not scanned for paths.

This is what allows the platform to write its own source code, including tests that quote a destructive command, while a command that actually runs one is still denied.


## Residual Limitations

These are genuine and are not fixed:

1. **No full shell parser.** The tokenizer understands quoting, escaping, operators, redirections, and command substitution by shape. It does not expand variables, evaluate globs, or resolve aliases and functions. A path produced only at runtime, by a shell expansion the tokenizer cannot see, is not a path operand.
2. **A script written now and executed later.** Writing a file whose contents are destructive is allowed, because writing is not executing. The later `bash script` call sees only the script name. This was equally true before the fix and is not a regression, but it is a real gap: the platform does not link a written file to its future execution.
3. **Encoded traversal in non-command content is inert.** Percent-encoded traversal is decoded and re-checked when it appears in a path operand or a command operand. The same text inside a document body is not decoded, because it is content.
4. **Device paths are allowed only as redirection targets.** A small, explicit set of device paths, the null device and the standard stream and file-descriptor nodes, plus the Windows device names, is skipped when it is the target of a redirection. As an ordinary argument such a path is still a real path and is still checked.
5. **Arguments reached through a tool with no schema** fall back to the conservative scan, so false positives remain possible for such tools until they declare a schema.
6. **A non-decodable percent-encoded value is matched in raw form only.** The redaction plane re-checks a value's decoded form so that a double-encoded credential cannot hide. `decodeURIComponent` throws on malformed input, and the raw value is returned unchanged in that case. The raw value is still pattern-matched by the ordinary credential rules, so this is not an unredacted path; what it means is narrower. A secret that is only recognisable in a *decoded* form cannot be recognised here, because the decoding needed to see it is exactly the decoding that failed. A credential that cannot be decoded is also not one that can be transmitted, so there is no usable credential in the gap.
7. **The vault is not wired into the production extension.** The vault tools are ordinary kernel descriptors that pass the same precheck as any other tool, and `vault_reveal` is CONTROLLED tier so it requires per-call operator approval. But the extension constructs `new KernelAdapter()` with no vault wiring and never calls `setVault`, and the committed policy document carries no `vault` block. Two independent conditions therefore both hold, and the tools cannot be reached in a production run at all. This is fail-safe rather than a hole: the credential surface is unreachable. It does mean the vault must not be described as a control that is currently protecting anything — it is implemented, unit-tested, and dark.
8. **The artifact size check is skipped for a reference that cannot be read.** `maxArtifactBytes` is enforced against real on-disk size when `createArtifact` registers a declared output. If `statSync` fails — most often because the output was declared before it was written — the check deliberately does not reject, on the reasoning that a reference that does not exist yet is not an oversize artifact and `verifyArtifact` is what decides whether it exists. A declared output that is never produced is therefore never size-checked.

