# Architecture

## Components

### Controller and builder

A single persistent EC2 instance runs the controller. Its EBS volume contains:

- the SQLite queue and deduplication state;
- a bare mirror of `datafusion-distributed`;
- one worktree per active job side in a build-only shared directory that is
  separate from controller state;
- Cargo registry and Git dependency caches; and
- revision-specific Cargo target directories.

Jobs are serialized initially. This avoids Cargo target locking and guarantees
that only one deployment owns the dedicated benchmark cluster.

### Human-managed benchmark foundation

The dedicated EKS cluster, namespaces, service accounts, node configuration, and
dataset bucket are provisioned from the repository's `benchmarks-remote/`
project. The bot is configured with their existing identifiers. It does not
create, modify, or destroy foundation resources.

The controller stack creates a separate private bucket for its root-owned
application bundle and content-addressed untrusted worker artifacts. The EC2
role can read the application prefix but can write only to the worker prefix.

The controller has a stable public IP for the cluster API allowlist. A human
registers its IAM role with namespace-scoped access to `benchmark-datafusion`.
The controller then manages only the DataFusion release and benchmark jobs in
that existing namespace.

### GitHub integration

The controller polls PR comments through the GitHub REST API using a manually
provisioned `GH_TOKEN`. It deduplicates comment IDs, validates the commenter's
repository permission, and accepts
`benchmarks run <suite>/<variant> [--instance-type <type>] [--nodes <count>]`
commands. Omitted capacity uses the upstream defaults of `c5n.2xlarge` and 12
nodes. It validates the instance-type token and limits requests to 24 nodes.
Polling keeps the EC2 instance private with no inbound internet listener. GitHub
authentication is not managed by Pulumi.

## Job sequence

1. Validate and persist the requested instance type and node count together with
   the PR base SHA and head SHA.
2. Create isolated worktrees for both immutable SHAs.
3. Fetch the base revision's locked dependencies as the unprivileged build user,
   then compile offline in a network-disabled systemd sandbox using persistent
   Cargo caches.
4. Let the controller upload and deploy the base artifact with the trusted
   harness bundled from this repository in a Helm release dedicated to the job.
5. Run the requested dataset and retain its local results.
6. Build, upload, and deploy the head artifact using the same process.
7. Run the identical benchmark arguments against the head deployment.
8. Render and post a comparison containing SHAs, configuration, per-query
   medians, total time, and failures.
9. Remove the job's DataFusion release and worktrees. Keep only bounded build
   caches for later compilations. On startup, remove stale job releases left by
   an interrupted controller process before retrying persisted work.

## Security boundary

Treat pull-request code as untrusted even when a maintainer requests the run.
Cargo build scripts and the resulting worker can execute arbitrary code.

- Run fetch and compilation as the separate `benchmark-build` account. It cannot
  read the controller's environment file or `GH_TOKEN`.
- Block EC2 metadata during dependency fetch. Run compilation with networking
  disabled, the source tree read-only, and only the revision-specific Cargo
  caches writable.
- Keep GitHub and deployment credentials in the controller process only.
- Give the controller a dedicated least-privilege AWS role scoped to describing
  the configured cluster, listing the dataset bucket, reading its application,
  and reading or writing only worker artifacts.
- Give benchmark pods only dataset-read permission.
- Never execute scripts or Helm charts from the pull request. Use the trusted
  deployment and benchmark harness bundled with the controller; consume only
  DataFusion Distributed source from the requested revisions.
- Restrict triggers to trusted repository roles and keep an auditable job
  record.

## Cache strategy

Use persistent EBS-backed Cargo registry, Git, and target directories outside
the private controller home. Cache directories are keyed by trust domain and
immutable SHA, and pruned least-recently-used when their configured total-size
limit is exceeded. The head receives a copy-on-write seed from the base cache,
so it reuses dependencies without allowing pull-request build output to become a
future trusted-base cache if that SHA is later merged. Add `sccache` only after
measuring cache misses.

## Failure behavior

Persist every state transition before performing the corresponding external
action. A restarted controller retries an interrupted job at most three times,
then fails it terminally. A deployment or benchmark interruption never advances
to the next side. Public comments contain only generic failure context; full
command output remains in the protected controller journal.
