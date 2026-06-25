---
name: ns-optimize-function
description: >-
  Optimizes a specific local Node.js function selected by the user. Use when the user points to code and asks to make it faster, improve throughput, reduce CPU/memory cost, or fix a slow function. Requires workspace source; analyzes blast radius, proposes a behavior-preserving rewrite, and hands off to benchmark validation. Not for live N|Solid diagnostics alone.
---

### 1. Acquire the Target Function
- The user selects a function via code-lens, names it, or pastes its code. Read it from the workspace.
- If they name it but don't point at a location, search the workspace for the definition and confirm the match before proceeding. Do not guess which definition they meant when multiple exist — ask.
- Record the exact file path, start/end lines, and the function signature.

### 2. Analyze Context & Impact
This is the grounding step. Do not write any optimization yet.
- Read the function body and everything it references (helpers, constants, external imports, closures).
- Search the workspace for **call sites** and **tests** to understand real usage and the actual input shapes callers pass in.
- Assess and state explicitly:
  - **What it does** and its current complexity — the algorithmic shape (loops, nested iterations, recursion, allocations, serialization, I/O).
  - **Blast radius** — how many call sites, whether it sits on a hot path (request handler, render, hot loop) or a cold path (startup, config load), sync vs async, and any concurrency/fan-out.
  - **Optimization worthiness** — is it actually worth optimizing? A cold startup path is rarely worth it; a per-request function is. If it is NOT worth optimizing, say so plainly and stop here rather than optimizing for the sake of it.

### 3. Baseline Benchmark
Measure before changing anything — optimization without a baseline is guessing.
- Delegate to the `ns-benchmark-run` skill to benchmark the **current** implementation. It builds the benchmark inputs and runs the measurement.
- Use the real inputs derived from step 2 (call sites / tests), not invented arguments.
- Record the baseline ops/sec. This is the number the optimization must beat.

### 4. Propose the Optimization
- Based on step 2's analysis, design ONE optimized rewrite targeting the dominant cost (algorithmic, allocation, I/O, caching, etc.).
- Present the change as a before/after diff with a short rationale tied to the specific cost you identified.
- **Human in the loop**: ask the user to approve the rewrite before benchmarking it. Do not run the optimized benchmark until they approve.

### 5. Validate (delegate to ns-validate-optimization)
- After approval, use the `ns-validate-optimization` skill to verify the improvement. It builds the benchmark inputs, runs the A/B comparison between the original and optimized code, and retries up to 3 times until the improvement clears the effectiveness threshold.
- Handoff payload: original code, optimized code, file path/lines, entry points, call-site/test evidence, and contract notes.
- Do NOT embed the benchmark mechanics here (`run_benchmark`, `get_benchmark_result`, `compare_benchmarks`, the retry loop) — `ns-validate-optimization` owns all of that.

### 6. Final Wrap-Up (Do Not Duplicate Validation Report)
- `ns-validate-optimization` owns the full benchmark report, save-to-disk prompt, and benchmark evidence/logs.
- After validation returns, give a concise wrap-up only: function/location, impact/worthiness, optimization rationale, final verdict, and saved validation report path if one exists.
- If validation exhausted 3 attempts without clearing the threshold, say so plainly and name the best measured attempt; never claim success.
- Do not write or save a second optimization report unless the user explicitly asks for a combined narrative report.
- If the workflow stops before validation (not worth optimizing, ambiguous target, or no approval), provide a short inline decision summary instead of a report.

## Guardrails
- Never optimize a function you have not benchmarked a baseline for first.
- Never skip the impact/worthiness assessment (step 2). A cold path is not a valid optimization target — say so and stop.
- Never embed benchmark mechanics. Delegate measurement and validation to `ns-benchmark-run` and `ns-validate-optimization`.
- Never propose an optimized rewrite that changes the function's contract (arguments, return shape, side effects, error behavior) unless the user explicitly approved that contract change. `ns-validate-optimization` compares the same contract — a different one invalidates the A/B comparison.
- If no tests or call sites exist, say so and derive the narrowest defensible inputs from the code itself — do not invent workloads.
- Never report a successful optimization that did not clear the effectiveness threshold. Report the best attempt and that it fell short.
