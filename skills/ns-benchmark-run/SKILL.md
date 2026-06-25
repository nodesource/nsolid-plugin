---
name: ns-benchmark-run
description: >-
  Benchmarks one Node.js function and reports throughput/statistics. Use when the user asks to benchmark or time a single function, measure ops/sec, compare input sizes, or answer "how fast is this code?" Use ns-validate-optimization instead when original and optimized versions need an A/B proof.
---

### 1. Acquire the Function Code and Project Context

This skill is triggered from a code-lens interaction inside the user's workspace, so the codebase is always available.

- Read the file the user points to and extract the target function.
- Inspect the surrounding module and search the workspace for:
  - real invocation sites
  - unit/integration tests that exercise the function
  - fixtures, mocks, or helper builders used by those tests
- Treat the codebase evidence as the primary source of truth for argument shape. Prefer arguments derived from real usage over generic placeholder values.
- If you cannot find tests or call sites, say that clearly and derive the narrowest defensible benchmark inputs from the code itself.

### 2. Build `functionData`

Every benchmark call requires a `functionData` object. Build it carefully:

#### `type` — code structure type
- `"function"` — function declaration or expression
- `"class"` — class-based implementation
- `"snippet"` — multiple functions, classes, or code elements together
- `"anonymous_function"` — anonymous function

#### `code` — the JavaScript source string
- Do NOT include `module.exports`

#### `explanation` — describe what the function does
- For a single benchmark run this is just a description of the function's purpose

#### `entryPoint` — the name of the function or method to call
- For functions: the function name
- For classes: the method name to call after instantiation
- For snippets: can be omitted

#### `args` — arguments to pass when benchmarking

Follow these steps to build `args` correctly:

1. Examine the function and all code it references
2. Search the codebase for actual invocation sites and tests before inventing arguments
3. If tests exist for the function or its immediate caller, inspect those tests and reuse their argument shapes, fixtures, mocks, and setup patterns when appropriate
4. Identify every external variable or object that is referenced but NOT defined inside the function as a local variable or parameter
5. For **simple primitives** (numbers, strings, booleans), add their values directly to `args`: `[5, "test", true]`
6. For **complex external dependencies** (objects with methods, arrays that get mutated, db handles, event emitters, etc.):
   - Add the dependency as an **explicit parameter** to the function signature
   - Define it as a mock in `argSetupCode`
   - Add the **parameter name** (not the value) to `args`
7. When the codebase evidence conflicts with a generic mock, follow the codebase evidence

#### `argSetupCode` — mock definitions for complex dependencies
- Only include when you need to pass complex objects
- Plain JS string that defines mock variables
- The variable names here must match the names you added to `args`

#### `benchmarkConfig` — benchmark engine configuration
- Controls how many times the benchmark executes and for how long
- Default values:
  - `repeatSuite`: 15 (number of suite runs — higher values improve statistical accuracy but take longer)
  - `minSamples`: 10 (minimum samples required per run)
  - `minTime`: 0.05 (minimum time per sample in seconds)
  - `maxTime`: 0.5 (maximum time per sample in seconds)
- These defaults are a good starting point. The user can modify them during the confirmation step.

### 3. Stop and Ask the User to Confirm the Arguments and Configuration

Before calling any benchmark tools, present the proposed `functionData` and `benchmarkConfig` to the user for review.

Your confirmation message must include:
- the target function and where you found it
- the proposed `entryPoint`
- the full `args`
- the full `argSetupCode` if present
- the proposed `benchmarkConfig` values (repeatSuite, minSamples, minTime, maxTime) with a brief explanation of each
- a short explanation of how the arguments were derived from real invocation sites and/or tests

If you found relevant tests, mention which test file(s) or fixtures informed the argument shape.

After presenting, explicitly offer to:
- adjust the `benchmarkConfig` (e.g. increase repeatSuite for more statistical accuracy, or decrease it for faster runs)
- approve the proposed arguments and configuration as-is
- ask you to regenerate arguments
- provide manual edits

For example, if repeatSuite is set to 15 but the function is very fast, suggest increasing it. If the function is slow, suggest decreasing it to get results faster.

Do NOT call `run_benchmark`, `get_benchmark_result`, or any result-saving step until the user explicitly confirms both the arguments and the configuration.

---

### Argument Examples (key pattern)

For complex external dependencies, add the dependency as an **explicit parameter** to the function signature, mock it in `argSetupCode`, and pass the **parameter name** (not the value) in `args`. Example (HTTP req/res):

```
// Original:    function exampleFn(req, res) { arrExample.push(JSON.parse(resp)); res.end(); }
// Transformed: function exampleFn(req, res, arrExample) { arrExample.push(JSON.parse(resp)); res.end(); }
args: ["req", "res", "arrExample"]
argSetupCode:
  const req = { url: '/test' };
  const res = { writeHead: function() {}, write: function() {}, end: function() {} };
  const arrExample = [];
```

For more patterns (DB, FS, event emitters, async/await, class instantiation), see `reference/benchmark-inputs.md` in this skill's directory.

---

### 4. Run the Benchmark

Call `run_benchmark` with:
- `functionData`: the object built in step 2 (`type`, `code`, `explanation`, `entryPoint`, `args`, and `argSetupCode` if needed)
- `isOptimized: false`
- Pass the user-confirmed `benchmarkConfig` only if the `run_benchmark` schema exposes that parameter (or `functionData.benchmarkConfig`). If not, record the desired config in the report and state that tool defaults were used.

Note the returned `jobId`.

### 5. Wait

Run the wait script (use the absolute path of the directory where you read this SKILL.md):

```
node "<skill-dir>/wait.cjs" 20
```

### 6. Get the Result

Call `get_benchmark_result` with the `jobId`. If `status` is not yet `"completed"`, run `node "<skill-dir>/wait.cjs" 5` and poll again. Poll up to **12 times**; if still not completed, report the `jobId` and incomplete status rather than looping indefinitely.

Extract the full `result` object from the response. It contains:
- `result.name` — the benchmark name
- `result.plugins` — any plugins that ran (e.g., V8NeverOptimizePlugin)
- `result.opsSec` — average operations per second
- `result.opsSecPerRun` — per-run ops/sec values
- `result.iterations` — total iterations executed
- `result.histogram` — timing distribution with `samples`, `min`, `max`, and `sampleData`
- `result.benchmarkConfig` — the configuration used (repeatSuite, minSamples, minTime, maxTime)

Keep the full `result` JSON available to present to the user.

### 7. Build a Markdown Benchmark Report

Build a markdown report with these sections:
- title/date/type/function/source/benchmark ID (when available)
- `## Summary`
- `## Request`
- `## Results`
- `## Tool Execution Log`

For `## Tool Execution Log`, include the raw input/output pairs for the `run_benchmark` call and every `get_benchmark_result` poll for the same `jobId`, in chronological order.

### 8. Present Results

Use the markdown report from step 7 as the final answer body. Present the benchmark results in a markdown table. Include all relevant metrics from the `result` object so the user can see the full performance picture at a glance.

The table must include:
- **Function**: the entry point name
- **ops/sec**: the average operations per second
- **Iterations**: total iterations executed
- **Runs**: number of suite runs
- **Histogram min/max**: the fastest and slowest execution times in the distribution
- **Histogram samples**: number of samples collected
- **Config**: key benchmark settings (repeatSuite, minSamples, minTime, maxTime)
- **Plugins**: any active plugins (e.g., V8NeverOptimizePlugin)
- **Variance assessment**: whether the histogram shows high variance (high min/max spread suggests inconsistent performance)
- **Benchmark ID**: the benchmark job/reference identifier when available

Example table format:

| Metric | Value |
|--------|-------|
| Function | `<entryPoint>` |
| ops/sec | <n> |
| Iterations | <n> |
| Runs | 15 |
| Histogram min/max | <min> ms / <max> ms |
| Config | repeatSuite=15, minSamples=10, minTime=0.05s, maxTime=0.5s |
| Variance | High/Low (min/max spread is <n>x) |
| Benchmark ID | `<id>` |

When variance is **high** (wide min/max spread), append a diagnostic line: note likely causes (V8 JIT tier transitions, GC pauses on allocating functions, system load/CPU throttling, or input sensitivity) and recommend increasing `repeatSuite`/`minSamples` or inspecting per-run ops/sec for outliers.

### 9. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/benchmark-<entryPoint>.md`. Report the saved path to the user.

## Guardrails
- NEVER skip searching for real call sites and tests before proposing arguments — the workspace is always available in this flow.
- If tests exist for the target function or its immediate caller, inspect them before proposing benchmark inputs.
- NEVER run benchmark tools before the user confirms both the proposed arguments AND the benchmark configuration.
- NEVER skip the wait step — always use `wait.cjs`, do not rely on estimating time.
- Pass `isOptimized: false` — this is a baseline run, not a comparison.
