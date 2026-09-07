# Nested spacectl discovery and bounded concurrent detection

Linear: [REMOTE-3146](https://linear.app/warpdotdev/issue/REMOTE-3146/discover-nested-build-tools-with-concurrent-spacectl-cache-setup)

Originating Slack thread:
[C0BDQDW8V5E / 1788767403.717799](https://warpdev.slack.com/archives/C0BDQDW8V5E/p1788767403717799)

Code references use warp commit
[`51242b5f0af80fff81613ff6561eed29ba8922fa`](https://github.com/warpdotdev/warp/tree/51242b5f0af80fff81613ff6561eed29ba8922fa)
on `master`.

## Summary

Build-cache setup detects tools only at each repository root. Nested projects are missed.
Implement a two-phase flow. First, scan each repository once for detector-aligned markers and
produce the complete bounded candidate set. Second, detect all candidates across all repositories
through one shared concurrency limit. Keep cache-directory creation and all real mounts serial.
Keep the synthetic global mount last.

## Context

- [`prepare_environment_impl`](https://github.com/warpdotdev/warp/blob/51242b5f0af80fff81613ff6561eed29ba8922fa/app/src/ai/agent_sdk/driver/environment.rs#L373-L452)
  runs cache setup after cloning and before setup commands. Cache failures do not abort environment
  preparation.
- [`setup_caches`](https://github.com/warpdotdev/warp/blob/51242b5f0af80fff81613ff6561eed29ba8922fa/app/src/ai/agent_sdk/driver/cache_setup.rs#L44-L112)
  creates one `RepositoryCacheSource` per checkout and reports invocation failures.
- [`setup_cache`](https://github.com/warpdotdev/warp/blob/51242b5f0af80fff81613ff6561eed29ba8922fa/crates/build_cache/src/lib.rs#L450-L646)
  detects repositories serially, constructs a plan, and applies every mount serially.
- [`construct_plan`](https://github.com/warpdotdev/warp/blob/51242b5f0af80fff81613ff6561eed29ba8922fa/crates/build_cache/src/lib.rs#L688-L773)
  appends a global union of all detected modes. The global configuration must remain last because a
  mode can mix cwd-relative paths with shared paths.
- [`run_spacectl_mount`](https://github.com/warpdotdev/warp/blob/51242b5f0af80fff81613ff6561eed29ba8922fa/crates/build_cache/src/spacectl.rs#L116-L193)
  uses the command cwd for both detection and mounting. The default runner applies a 60-second
  timeout and `kill_on_drop(true)`.
- `spacectl` 0.12.2 detection is cwd-only. A local triage fixture measured four detects at about
  196 ms serially and 127 ms concurrently. These measurements show benefit, not a performance
  guarantee.

## Technical design

### 1. Discover candidate roots before starting detection

Add a filesystem-only discovery helper in `crates/build_cache`. Run it once for every
`RepositoryCacheSource` before any detection future starts.

- Always include the repository root. It has depth 0 and does not count against the child limit.
- Use sorted breadth-first traversal. Sort siblings by normalized repository-relative path.
- Permit candidate roots at depths 1 through 4. Do not enqueue children of a depth-4 directory.
- Visit at most 10,000 non-ignored, non-symlink directories per repository, including the root.
- Retain at most 32 child candidates per repository. When a 33rd child candidate is found, mark the
  scan truncated and stop that repository's traversal.
- When the visit limit is reached with work remaining, mark the scan truncated and stop traversal.
- On truncation, retain the root and the deterministic candidates already selected. Continue cache
  setup.
- Skip a directory subtree before counting or reading it when its entry name is `.git`,
  `node_modules`, `target`, `Pods`, `vendor`, `dist`, `build`, `.venv`, `.tox`, or `DerivedData`.
- Do not follow symlinks to files or directories. A symlink itself is not a marker.
- If a non-root directory cannot be read, skip that subtree, record one scan warning, and continue.
  A missing or unreadable repository root still proceeds to root detection, which preserves the
  existing per-invocation error path.

Normalize a child root by stripping the repository root and accepting only non-empty normal UTF-8
components. Join components with `/`. Preserve case and Unicode bytes. Skip a child path that is
non-UTF-8 or contains a root, prefix, `.` or `..` component. Do not canonicalize child paths or
resolve symlinks.

Deduplicate exact normalized roots. A directory with multiple markers is one candidate. Retain both
a parent project root and a nested project root when each has a marker.

### 2. Align marker rules with spacectl

The marker table must mirror the detector inputs in the spacectl version shipped on Namespace
workers. For spacectl 0.12.2, use these rules:

- Exact entries: `Brewfile`, `bun.lock`, `Podfile`, `composer.json`, `deno.lock`, `go.mod`,
  `go.work`, `.golangci.yml`, `.golangci.yaml`, `gradlew`, `build.gradle`, `pom.xml`, `mise.toml`,
  `.mise.toml`, `.tool-versions`, `flake.nix`, `shell.nix`, `default.nix`, `package-lock.json`,
  `pnpm-lock.yaml`, `poetry.lock`, `requirements.txt`, `Gemfile`, `Cargo.toml`, `Package.swift`,
  `Tuist.swift`, `tuist.toml`, `uv.lock`, and `yarn.lock`.
- Exact relative entries: `mise/config.toml`, `.mise/config.toml`, `.config/mise.toml`, and
  `.config/mise/config.toml`. The candidate is the ancestor from which spacectl checks that relative
  path, not the marker's immediate parent.
- Directory entry: `Tuist`.
- Suffix entries: directories ending in `.xcodeproj` or `.xcworkspace`.

For exact, directory, and suffix entries, the candidate is the directory that contains the matched
entry. A marker entry is never itself the candidate.

Do not add looser markers that 0.12.2 does not use, including bare `package.json`,
`pyproject.toml`, `settings.gradle`, or `build.gradle.kts`. Tool-binary checks remain spacectl's
responsibility. Binary-only modes such as `apt`, Kotlin Native, and Playwright are discovered at the
always-included repository root; they do not cause child candidates.

Before implementation, verify the worker's shipped spacectl version and compare its provider source
with this table. If detector semantics differ, update this spec and the table in the same PR.

### 3. Prepare stable isolated cache roots

Create all selected configuration roots serially before detection. A creation failure skips only
that candidate and produces the existing non-fatal degradation report.

- Preserve the current root cache path: `repos/<repo-key>`.
- Use `repos/<repo-key>/nested/<stable-id>` for a child root.
- Compute `<stable-id>` as lowercase hexadecimal SHA-256 of the normalized `/`-separated relative
  path. Do not hash an absolute checkout path.
- Validate that all configuration cache paths are safe relative paths and unique.
- If two distinct roots produce the same configuration path, reject the plan before real mounts,
  record one non-fatal plan-invariant degradation, and continue environment preparation. Never share
  the path.

This scheme preserves existing root cache hits and isolates equal relative mount names such as
`frontend/target` and `backend/target`.

### 4. Detect the complete candidate set with one shared limit

After discovery and serial directory preparation complete for every repository, build one ordered
work list across all repositories. Order by `RepoCacheKey`, then root before children, then normalized
child path.

- Change the command hook from exclusive `FnMut` use to a concurrency-safe `Fn` shape. Tests must
  use shared synchronization such as `Arc<Mutex<...>>`; do not serialize the production scheduler
  behind the fake-runner API.
- Schedule the entire work list through one bounded unordered stream with a limit of 8. The limit is
  shared across repositories.
- Run `spacectl cache mount --detect='*' --dry_run=true` with each candidate as cwd and its isolated
  cache root.
- Preserve the 60-second timeout and `kill_on_drop(true)` for every invocation.
- An invocation failure, timeout, malformed response, or empty mode set affects only that root.
- Do not cancel siblings after a failure.
- Reorder results into the canonical work-list order before constructing the plan or returning the
  report. Completion order must not affect the plan, mount order, environment overlay, or telemetry
  report order.

### 5. Plan and apply mounts serially

Create one repository-scoped `CacheConfiguration` for every successful non-empty detection. Multiple
configurations may share a `RepoCacheKey`, but every configuration must have a unique cwd and cache
directory.

- Update `CacheSetupPlan::validate` and its documentation to permit repeated ordered repository keys
  and require unique repository configuration paths.
- Sort repository configurations by repo key, then root before child, then normalized child path.
- Union all successful detected modes with `additional_global_modes` for one global configuration.
- Run every real repository mount serially in canonical plan order.
- Run the global mount serially after all repository mounts.
- Create the global cache directory serially.
- Preserve current last-successful-repository environment overlay behavior and global-environment
  precedence. Resolve any duplicate repository environment keys by canonical plan order.
- Preserve `prepare_environment_impl` behavior: any cache degradation is reported, but environment
  preparation continues.

Do not attempt concurrent real mounts in v1. Rust, for example, can combine `./target` with shared
Cargo paths. Concurrent mounts can race even when cache-root leaves differ.

Nested discovery applies wherever the existing build-cache gate enables setup. V1 must work on
Namespace Linux and macOS without enabling caching on any new platform. Keep filesystem helpers and
unit tests platform-neutral so the crate continues to compile on other supported targets.

### 6. Logging and telemetry

Create one discovery span per repository. Record visited directory count, selected child count,
ignored subtree count, unreadable subtree count, and truncation reason (`directory_limit` or
`candidate_limit`). Record total scheduled detects and the configured detection limit on the
cache-setup span.

Add the root depth and stable child ID to detection spans. Do not put raw absolute checkout paths in
safe logs or Sentry extras. Emit one warning per truncated repository and one aggregate warning per
repository for unreadable subtrees. Expected limit truncation is non-fatal and must not cancel
detection or mounting.

## Decisions

- **Marker scan instead of spacectl in every directory.** A bounded marker scan avoids process spam
  and matches cwd-based detector semantics. Calling spacectl for every directory was rejected
  because repository breadth and 60-second per-process timeouts make latency unbounded.
- **Complete scan before concurrent detection.** Scheduling while walking was rejected. It makes
  concurrency dependent on traversal order and does not satisfy the request to detect the full root
  set through one shared scheduler.
- **Eight shared detection slots.** This captures the measured concurrency benefit while bounding
  process and detector fan-out. A per-repository limit was rejected because multiple repositories
  could exceed the intended host-wide limit.
- **Serial real mounts.** Concurrent mounts were rejected for v1 because isolated cache leaves do
  not isolate shared destination paths. The global mount remains last.
- **Preserve the root cache path.** Moving all roots under a new namespace was rejected because it
  would discard existing root cache hits.
- **Hash normalized child paths.** Raw relative paths are easier to inspect but can be long and
  platform-sensitive. A full SHA-256 produces a stable safe component. Telemetry retains the depth
  and stable ID for correlation.

## Assumptions

- The Namespace worker still ships spacectl detector semantics equivalent to 0.12.2. Implementation
  must verify this before coding.
- Repository-relative project paths are UTF-8. A non-UTF-8 child path is skipped rather than given a
  platform-specific cache identity.
- The current cache setup remains before user setup commands. Tools installed only by setup commands
  remain unavailable to detection.
- Overlapping real spacectl mounts are not proven safe on Linux or macOS. V1 does not rely on that
  behavior.

## Out of scope

- Recursive detection changes in spacectl or Namespace.
- Calling spacectl in directories without detector-aligned markers.
- Moving cache setup after user setup commands.
- Concurrent cache-directory creation or real mount invocations.
- New detectors or support for looser manifests that the shipped spacectl does not recognize.
- UI changes or computer-use verification.

## Validation criteria

1. `cargo nextest run -p build_cache` passes and includes unit coverage for:
   - every direct, relative, directory, and suffix marker rule;
   - non-markers such as bare `package.json`, depth 5, ignored trees, and symlinks;
   - exact deduplication while retaining marked parent and child roots;
   - sorted breadth-first selection, the 10,000-directory limit, and 32 children plus root;
   - deterministic truncation and unreadable-subtree isolation;
   - stable cross-separator child IDs, preserved root cache paths, and unique safe cache paths;
   - a fake runner that observes more than one and no more than eight simultaneous detects across
     multiple repositories;
   - per-root failure and timeout isolation, `kill_on_drop`, deterministic report ordering, serial
     mount execution, and the global mount last;
   - repeated ordered repository keys and unique cache-directory plan invariants.
2. `cargo nextest run -p warp cache_setup` passes to confirm Namespace gating, source mapping,
   degradation reporting, and environment export behavior remain compatible.
3. Extend `crates/build_cache/examples/validate_spacectl.rs` with one repository containing root,
   `frontend`, and `backend` fixtures. With the worker's spacectl version available,
   `cargo run -p build_cache --example validate_spacectl -- --reset` must show:
   - one detect per selected root;
   - the expected nested modes;
   - distinct nested cache roots;
   - serial real mounts in canonical order;
   - one final global mount.
4. Record five-run medians for a 32-child fixture with serial detection and the concurrency-8
   implementation on a Namespace Linux worker. Concurrent median wall time must not exceed the
   serial median. Record scan time and process counts; do not add a hardware-dependent unit-test
   latency threshold.
5. Verify the marker table against the exact spacectl provider source deployed on the validation
   worker. Link the source tag or commit in the implementation PR.
6. Before any follow-up enables concurrent real mounts, run controlled overlapping-mount tests for
   mixed relative/global modes on Namespace Linux and macOS. V1 passes without this experiment
   because all real mounts remain serial.
7. Run `./script/format`, the clippy command selected by `./script/presubmit`, and `git diff --check`
   before implementation review. No computer-use artifact is required.

## Parallelization

Use one implementer for discovery, plan changes, runner refactoring, and unit tests because these
changes share the `setup_cache` contract and fake-runner seam. After unit tests pass, Linux timing
validation and the optional macOS mount-safety investigation can run independently. Land all spec,
implementation, and validation updates in this PR.
