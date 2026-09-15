# Reliable Scheduled Collection

Use this reference when one Dyna schedule collects several source slices in parallel.

## Budget work that can finish

- Size a worker's deadline from its required calls and pagination. Do not require an exhaustive multi-query sweep to finish inside an arbitrary short shared timeout.
- Give each worker a collection cutoff and reserve at least one final minute to stop new reads, normalize evidence, and return a terminal result.
- Join completed workers as they finish. Before the hard deadline, request an immediate bounded final from unfinished workers; do not discard completed slice results merely because another worker is still running.
- A worker that owns several slices reports each one independently. Completed slices remain usable even when a sibling slice is incomplete.
- During a scheduled collection run, use the source skill's established commands. Do not spend the collection budget researching documentation or redesigning the connector workflow.

Prefer a broad bounded query first and subdivide only when the response is actually capped or truncated. Prefer exact reviewer, assignee, project, or date filters over hydrating a broad tenant-wide result.

## Avoid recursive delegation

When a source skill requires internal delegation, launch the source operation itself as that delegated worker. Tell the worker that it is already the required operation sub-agent and must execute the source operation directly without delegating the same operation again. This is especially important for Slack, whose normal entrypoint deliberately delegates verbose authenticated work away from the parent task.

## Interpret completeness precisely

A cap is a failure only when the slice promises exhaustive coverage and the cap leaves relevant records unvisited. Reaching the documented bound of an intentionally bounded inventory is not itself an error.

For native Codex inventory:

- Call `list_threads` once with the chosen bound and filter exact project or working-directory scope before evaluating task state.
- The requested list bound defines the slice; returning that many records does not make the slice incomplete.
- `notLoaded` describes app loading state, not a native task failure or a task waiting for input. Skip it unless an exact in-scope task must be resolved.
- Use `unavailableHosts`, `unavailableSources`, or a failed native call as coverage failures. If exact in-scope task status is required, inspect only a small bounded set with the native metadata/status tools; do not read transcripts or outputs.

## Publish honest partial results

Every worker returns a terminal `SUCCEEDED`, `COMPLETE ZERO`, or `FAILED` result for each owned slice, plus a bounded reason for a failure. The parent must publish all successful slices and mark only incomplete slices failed. Dyna then preserves failed slices' last-known records. Never turn a worker timeout into a successful empty slice, and never turn one worker's timeout into a blanket failure for independent completed sources.

Invoke the exact registered publisher launcher through the task's required escalated-execution metadata so its narrow Codex allow rule applies without interactive approval; never request a broader shell or runtime rule. Send the complete bounded envelope once through the documented PTY protocol. If the launcher is denied or rejects the envelope, stop and report publication as blocked—do not retry through wrappers, pipes, redirection, alternate runtimes, or improvised terminal workarounds. Source-sliced runs retain `replace` mode because Dyna retires omissions only for declared successful slices and preserves every failed slice.
