# Architecture

## Components

### Controller and builder

A single persistent EC2 instance runs the controller. Its EBS volume contains:

- the SQLite queue and deduplication state;
- a bare mirror of `datafusion-distributed`;
- one worktree per active job side;
- Cargo registry and Git dependency caches; and
- revision-specific Cargo target directories.

Jobs are serialized initially. This avoids Cargo target locking and guarantees
that only one deployment owns the dedicated benchmark cluster.

### Human-managed benchmark foundation

The dedicated EKS cluster, namespaces, service accounts, node configuration, and
dataset bucket are provisioned from `datafusion-distributed/benchmarks-remote`.
The bot is configured with their existing identifiers. It does not create,
modify, or destroy foundation resources.

The controller has a stable public IP for the cluster API allowlist. A human
registers its IAM role with namespace-scoped access to `benchmark-datafusion`.
The controller then manages only the DataFusion release and benchmark jobs in
that existing namespace.

### GitHub integration

The controller polls PR comments through a manually authenticated `gh` CLI. It
deduplicates comment IDs, validates the commenter's repository permission, and
accepts only `benchmarks run <suite>/<variant>` commands. Polling keeps the EC2
instance private with no inbound internet listener. GitHub authentication is not
managed by Pulumi.

## Job sequence

1. Resolve and persist the PR base SHA and head SHA.
2. Create isolated worktrees for both immutable SHAs.
3. Fetch the base revision's locked dependencies as the unprivileged build user,
   then compile offline in a network-disabled systemd sandbox using persistent
   Cargo caches.
4. Let the controller upload and deploy the base artifact.
5. Run the requested dataset and retain its local results.
6. Build, upload, and deploy the head artifact using the same process.
7. Run the identical benchmark arguments against the head deployment.
8. Render and post a comparison containing SHAs, configuration, per-query
   medians, total time, and failures.
9. Preserve caches, remove job worktrees, and leave the head deployment running
   for diagnostics until the next job replaces it.

## Security boundary

Treat pull-request code as untrusted even when a maintainer requests the run.
Cargo build scripts and the resulting worker can execute arbitrary code.

- Run fetch and compilation as the separate `benchmark-build` account. It cannot
  read the controller's `gh` configuration or environment file.
- Block EC2 metadata during dependency fetch. Run compilation with networking
  disabled, the source tree read-only, and only the revision-specific Cargo
  caches writable.
- Keep GitHub and deployment credentials in the controller process only.
- Give the controller a dedicated least-privilege AWS role scoped to describing
  the configured cluster and reading or writing only the bot artifact prefix.
- Give benchmark pods only dataset-read permission.
- Never execute scripts or Helm charts from the pull request. Use the trusted
  immutable base revision's deployment and benchmark harness; consume only the
  worker artifact built from the pull request.
- Restrict triggers to trusted repository roles and keep an auditable job
  record.

## Cache strategy

Use persistent EBS-backed Cargo registry, Git, and target directories. Cache
directories are keyed by immutable SHA. The head receives a copy-on-write seed
from the base cache, so it reuses dependencies without allowing pull-request
build output to poison the trusted base cache. Add `sccache` only after
measuring cache misses.

## Failure behavior

Persist every state transition before performing the corresponding external
action. A restarted controller resumes or fails the current job explicitly. A
deployment or benchmark interruption never advances to the next side. Post one
terminal GitHub comment with the failing phase and retain enough logs for
diagnosis.
