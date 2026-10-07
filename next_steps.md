# Next Steps for Stage 1: Conductor Loop

## Current State
The Conductor class (`platform/conductor/conductor.ts`) implements the clarify → plan → execute → deliver loop:
- **Clarify**: Prompts for the input file (up to 3 rounds) using framed input (`input=...`) or by guessing a file path with extension `.csv` (only) in the unframed case.
- **Plan**: Begins a kernel task with the resolved file path.
- **Execute**: 
  - Reads the file via the governed `csv_read` tool.
  - In `dashboard` mode (default): renders a self-contained HTML dashboard via the `render_page` tool.
  - In `bottleneck` mode: runs bottleneck analysis (`analyseBottlenecks`) and renders a Markdown report via `render_bottleneck_report`.
- **Deliver**: Finalizes the kernel task and returns the result.

The necessary tools (`csv_read`, `render_page`, `render_bottleneck_report`, `analyseBottlenecks`) are implemented in `platform/conductor/capabilities.ts` and related files.

## Required Work to Complete Stage 1
To ensure the Conductor loop robustly supports the wedge (one‑page dashboard from a CSV, JSONL, or log file), the following files need to be modified or created:

### 1. Modify: `platform/conductor/conductor.ts`
   - Fix the `locateInput` method to recognize all supported file extensions (`.csv`, `.tsv`, `.jsonl`, `.jsonlines`, `.ndjson`, `.log`) in the unframed fallback.  
     Current regex: `/[\w./\\-]+\.csv\b/i`  
     Change to: `/[\w./\\-]+\.(csv|tsv|jsonl|jsonlines|ndjson|log)\b/i`  
   - This allows the clarify step to accept JSONL and log files when the user types a bare filename (no framing).

### 2. Create: `platform/conductor/conductor.class.test.ts`
   - Test file for the Conductor class to verify:
     - Clarify step correctly handles framed input (`input=...`) for any supported format.
     - Clarify step correctly guesses unbracketed filenames with supported extensions.
     - Clarify step repeats up to 3 times when no valid input is given.
     - Plan step begins a kernel task with the resolved path.
     - Execute step in dashboard mode produces an HTML dashboard via `render_page`.
     - Execute step in bottleneck mode produces a Markled report via `analyseBottlenecks` + `render_bottleneck_report`.
     - Deliver step returns the expected `ConductorResult`.
     - Edge cases: invalid characters in filenames, empty input, etc.

## Notes
- No changes are required to the tools (`csv_read`, `render_page`, etc.) as they already support multiple formats via omnivorous ingest.
- The web server and CLI currently bypass the Conductor's clarify step by resolving the path themselves; this fix ensures the Conductor class can be used standalone (e.g., in tests or direct invocation) with the same flexibility.