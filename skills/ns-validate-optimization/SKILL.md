---
name: ns-validate-optimization
description: >-
  Validates a proposed optimization with controlled A/B benchmarks. Use when original and optimized versions of the same Node.js function need statistical proof, ops/sec comparison, p-value/significance, or a performance regression check. Also fits after ns-optimize-function or diagnostics produce a candidate fix. Use ns-benchmark-run for single-version timing only.
---

### 1. Acquire Both Implementations and Inspect Their Project Context

This skill is usually called after `ns-cpu-spike-analysis`, which sets a workspace context flag indicating whether the code is available locally.

**If the workspace context flag says the code is available:**
- Read the original and optimized implementations from the workspace files.
- Search the codebase for real invocation sites of the original function.
- Search for unit/integration tests covering the original function or its immediate caller.
- Inspect the argument shapes, fixtures, mocks, and helper builders used in those tests.
- Use the original implementation's real calling pattern as the source of truth for benchmark inputs.

**If the workspace context flag says the code is NOT available:**
- Use the code provided by the user or from the prior `ns-cpu-spike-analysis` flow.
- Say clearly that no workspace or tests are available.
- Derive the narrowest defensible benchmark inputs from the code itself.

If the optimized implementation has a different entry point or wrapper shape, account for that separately, but keep the benchmark contract aligned with the original usage unless the user explicitly says the contract changed.

### 2. Build `functionData` for Original and Optimized

Every benchmark call requires a `functionData` object. You will build **two** of them — one for the original, one for the optimized — using the **exact same** `args` and `argSetupCode` in both.

#### `type` — code structure type
- `"function"` — function declaration or expression
- `"class"` — class-based implementation
- `"snippet"` — multiple functions, classes, or code elements together
- `"anonymous_function"` — anonymous function

#### `code` — the JavaScript source string
- Do NOT include `module.exports`

#### `explanation`
- For the original: describe what the function does
- For the optimized: describe the specific changes made to improve it

#### `entryPoint` — the name of the function or method to call
- For functions: the function name
- For classes: the method name to call after instantiation
- For snippets: can be omitted

#### `args` — arguments for benchmarking

Follow these steps:

1. Examine the original function and all code it references
2. Search the codebase for actual invocation sites and tests before inventing arguments
3. If tests exist for the original function or its immediate caller, reuse their argument shapes, fixtures, mocks, and setup patterns when appropriate
4. Identify every external variable or object that is referenced but NOT defined inside the function as a local variable or parameter
5. For **simple primitives** (numbers, strings, booleans), add their values directly to `args`
6. For **complex external dependencies** (objects with methods, arrays that get mutated, db handles, etc.):
   - Add the dependency as an **explicit parameter** to BOTH original and optimized function signatures
   - Define it as a mock in `argSetupCode`
   - Add the **parameter name** (not the value) to `args`
7. `args` MUST be identical between the original and optimized runs — otherwise the comparison is invalid
8. `argSetupCode` MUST be identical between the original and optimized runs — otherwise the comparison is invalid
9. When test/codebase evidence conflicts with a generic mock, follow the codebase evidence

#### `argSetupCode` — mock definitions for complex dependencies
- Only include when you need to pass complex objects
- Plain JS string that defines mock variables
- Must be identical between the original and optimized runs

#### `benchmarkConfig` — benchmark engine configuration (shared by both runs)
- Controls how many times each benchmark executes and for how long
- Must be identical between the original and optimized runs — otherwise the comparison is invalid
- Default values:
  - `repeatSuite`: 15 (number of suite runs — higher values improve statistical accuracy but take longer)
  - `minSamples`: 10 (minimum samples required per run)
  - `minTime`: 0.05 (minimum time per sample in seconds)
  - `maxTime`: 0.5 (maximum time per sample in seconds)
- These defaults are a good starting point. The user can modify them during the confirmation step.

### 3. Stop and Ask the User to Confirm the Shared Benchmark Inputs

Before calling any benchmark tools, present both `functionData` objects and the proposed `benchmarkConfig` to the user for review.

Your confirmation message must include:
- the original and optimized functions being compared
- the proposed shared `args`
- the proposed shared `argSetupCode` if present
- each entry point
- the proposed shared `benchmarkConfig` values (repeatSuite, minSamples, minTime, maxTime) with a brief explanation of each
- a short explanation of how the shared benchmark inputs were derived from real invocation sites and/or tests

If relevant tests were found, mention which test file(s), fixtures, or helper builders influenced the proposed input shape.

After presenting, explicitly offer to:
- adjust the `benchmarkConfig` (e.g. increase repeatSuite for more statistical accuracy, or decrease it for faster runs)
- approve the proposed arguments and configuration as-is
- ask you to regenerate arguments
- provide manual edits

For example, if repeatSuite is set to 15 but the function is very fast, suggest increasing it. If the function is slow, suggest decreasing it to get results faster.

Do NOT call `run_benchmark`, `get_benchmark_result`, `compare_benchmarks`, or any result-saving step until the user explicitly confirms both the arguments and the configuration.

---

### Argument Examples (key pattern)

For complex external dependencies, add the dependency as an **explicit parameter** to BOTH original and optimized signatures, mock it in `argSetupCode`, and pass the **parameter name** (not the value) in `args`. Example (HTTP req/res):

```
// Original:    function exampleFn(req, res) { arrExample.push(JSON.parse(resp)); res.end(); }
// Transformed: function exampleFn(req, res, arrExample) { arrExample.push(JSON.parse(resp)); res.end(); }
args: ["req", "res", "arrExample"]
argSetupCode:
  const req = { url: '/test' };
  const res = { writeHead: function() {}, write: function() {}, end: function() {} };
  const arrExample = [];
```

For more patterns (DB, FS, event emitters, async/await, class instantiation), see `reference/benchmark-inputs.md` in the `ns-benchmark-run` skill directory.

---

### 4. Run Original Benchmark

Call `run_benchmark` with:
- `functionData`: `{ type, code, explanation, entryPoint, args, argSetupCode? }` for the **original**
- `isOptimized: false`
- Pass the user-confirmed `benchmarkConfig` only if the `run_benchmark` schema exposes that parameter (or `functionData.benchmarkConfig`). If not, record the desired config and state that tool defaults were used.

Note the returned `jobId` as `originalJobId`.

### 5. Wait

Run the wait script (use the absolute path of the directory where you read this SKILL.md):

```
node "<skill-dir>/wait.cjs" 20
```

### 6. Get Original Result

Call `get_benchmark_result` with `originalJobId`. If not yet `"completed"`, run `node "<skill-dir>/wait.cjs" 5` and poll again. Poll up to **12 times**; if still not completed, report the `originalJobId` and incomplete status rather than looping indefinitely.

Extract the full `result` object from the response. It contains:
- `result.name` — the benchmark name
- `result.plugins` — any plugins that ran (e.g., V8NeverOptimizePlugin)
- `result.opsSec` — average operations per second
- `result.opsSecPerRun` — per-run ops/sec values
- `result.iterations` — total iterations executed
- `result.histogram` — timing distribution with `samples`, `min`, `max`, and `sampleData`
- `result.benchmarkConfig` — the configuration used (repeatSuite, minSamples, minTime, maxTime)

Keep the full `result` JSON available to present to the user.

### 7. Run Optimized Benchmark Attempts

You must try the optimized implementation up to **3 total attempts** if the benchmark does not clear the effectiveness threshold on the first try.

For each optimized attempt:
- Build optimized `functionData`: `{ type, code, explanation, entryPoint, args, argSetupCode? }`
- Use the **exact same** `args`, `argSetupCode`, and `benchmarkConfig` as the original
- Call `run_benchmark` with `isOptimized: true`
- Pass `benchmarkConfig` only if the schema exposes it; if passed, it must be identical to the original run.
- Note the returned `jobId` as `optimizedJobId`

### 8. Wait

```
node "<skill-dir>/wait.cjs" 20
```

### 9. Get Optimized Result

Call `get_benchmark_result` with `optimizedJobId`. If not yet `"completed"`, run `node "<skill-dir>/wait.cjs" 5` and poll again. Poll up to **12 times**; if still not completed, report the `optimizedJobId` and incomplete status rather than looping indefinitely.

Extract the full `result` object from the response, with the same fields as the original run (name, plugins, opsSec, opsSecPerRun, iterations, histogram, benchmarkConfig).

Keep the full `result` JSON available to present to the user.

### 10. Compare Results

Call `compare_benchmarks` passing both `originalJobId` and `optimizedJobId`.

Analyze:
- `verdict`: `"optimization_effective"` requires both `isSignificant === true` AND `improvementPercent > 25`
- `pValue`: must be < 0.05 to be statistically significant
- `improvementPercent`: the percentage speed improvement

If the comparison is **not** `optimization_effective`:
- inspect the benchmark evidence and your current optimized code
- revise only the optimized implementation internals to attack the remaining bottleneck
- do not change arguments, return shape, side effects, sync/async behavior, error behavior, or mutability without explicit user approval
- rerun only the optimized side with a new optimized attempt
- keep the original benchmark as the baseline
- stop early if an attempt reaches `optimization_effective`
- otherwise continue until you have completed **3 optimized attempts total**

If none of the 3 optimized attempts reaches the threshold:
- report that clearly
- still present the **best** optimized attempt you measured
- make it explicit that the final result did not meet the effectiveness threshold

### 11. Build a Markdown Benchmark Report

Build a markdown report with these sections:
- title/date/type/function/location/benchmark ID (when available)
- `## Summary`
- `## Request`
- `## Results`
- `## Tool Execution Log`

The `## Results` section must include the benchmark verdict, improvement percentage, p-value, statistical significance, and the best optimized attempt if multiple retries were required.

For `## Tool Execution Log`, include the raw input/output pairs for each `run_benchmark` call and the matching `get_benchmark_result` polls for that same `jobId`, preserving chronological order across the original run and every optimized attempt.

### 12. Present Results

Present the comparison results in a markdown table showing original vs. optimized side by side. Include all relevant metrics so the user can see the full performance picture at a glance.

The table must include:
- **Function**: the entry point name
- **ops/sec (original)**: the average operations per second for the original
- **ops/sec (optimized)**: the average operations per second for the optimized
- **Improvement %**: the percentage improvement from the comparison
- **p-value**: the statistical significance value
- **Verdict**: whether the optimization is effective
- **Iterations (original)**: total iterations for the original
- **Iterations (optimized)**: total iterations for the optimized
- **Runs**: number of suite runs
- **Histogram min/max (original)**: the fastest and slowest execution times
- **Histogram min/max (optimized)**: the fastest and slowest execution times
- **Histogram samples**: number of samples collected
- **Config**: key benchmark settings (repeatSuite, minSamples, minTime, maxTime)
- **Plugins**: any active plugins (e.g., V8NeverOptimizePlugin)
- **Variance assessment**: whether either histogram shows high variance
- **Benchmark ID**: the benchmark job/reference identifier when available

Example table format:

| Metric | Original | Optimized |
|--------|----------|-----------|
| Function | `<entryPoint>` | `<entryPoint>` |
| ops/sec | <o> | <p> |
| Improvement % | — | +<n>% |
| p-value | — | <n> |
| Verdict | — | optimization_effective/not_effective |
| Iterations | <o> | <p> |
| Runs | 15 | 15 |
| Histogram min/max | <min> ms / <max> ms | <min> ms / <max> ms |
| Config | repeatSuite=15, minSamples=10, minTime=0.05s, maxTime=0.5s | repeatSuite=15, minSamples=10, minTime=0.05s, maxTime=0.5s |
| Variance | High/Low (<n>x) | High/Low (<n>x) |
| Benchmark ID | `<id>` | `<id>` |

When either side shows **high variance** (wide min/max spread), append a diagnostic line: note likely causes (V8 JIT tier transitions, GC pauses on allocating functions, system load/CPU throttling, input sensitivity) and recommend increasing `repeatSuite`/`minSamples` or inspecting per-run ops/sec for outliers.

As a recommended next step, advise the user to validate the optimization under representative load and capture fresh CPU profiles afterward. That follow-up helps confirm whether the function-level benchmark improvement produces a meaningful impact on end-to-end application performance.

### 13. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/benchmark-<entryPoint>.md`. Report the saved path alongside the final verdict.

### 14. Emit Structured Apply Metadata

After reporting the verdict, end the response with a single HTML comment containing the data the host extension needs to offer an "Apply optimization" action. Use the raw optimized source (unescaped newlines are fine inside a JSON string if you properly escape them), the final verdict flags, and any hot-function reference the extension provided in the prior CPU analysis.

```
<!-- nsolid-ide-optimized: {"code":"<optimized source>","entryPoint":"<entryPoint>","improvementPct":<number>,"pValue":<number>,"isSignificant":<bool>,"verdictEffective":<bool>} -->
```

Only emit the marker when a valid A/B comparison completed. If the benchmark failed, timed out, or the original/optimized code was unavailable, omit the marker entirely — the host extension will not offer the apply action.

## Guardrails
- When the workspace is available, NEVER skip searching for real call sites and tests before proposing arguments.
- If tests exist for the original function or its immediate caller, inspect them before proposing benchmark inputs.
- NEVER run benchmark tools before the user confirms both the proposed shared arguments AND the benchmark configuration.
- The `args`, `argSetupCode`, and `benchmarkConfig` MUST be identical for both runs — otherwise the A/B comparison is statistically invalid.
- NEVER skip the wait steps — always use `wait.cjs`, do not rely on estimating time.
- A fix is not a fix until `compare_benchmarks` returns `"optimization_effective"`.
- NEVER poll immediately after submitting a benchmark — always wait first.
- If an optimized attempt does not pass the threshold, do not stop after one miss. Revise within the approved contract and retry until you either succeed or finish 3 optimized attempts total.
