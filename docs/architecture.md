# Architecture

## Components

### Controller and builder

A single persistent EC2 instance runs the controller. Its EBS volume contains:

- the SQLite queue and deduplication state;
- a bare mirror of `datafusion-distributed`;
- one worktree per active job side;
- Cargo registry and Git dependency caches; and
- a shared Cargo target directory.

Jobs are serialized initially. This avoids Cargo target locking and guarantees
that only one deployment owns the dedicated benchmark cluster.

### Dedicated benchmark foundation

The bot uses a separate Pulumi stack and EKS cluster. It may share immutable
dataset objects, but it has distinct Kubernetes tenancy, engine releases,
artifact prefixes, IAM roles, and benchmark locking from interactive runs.

### GitHub integration

The controller polls PR comments using a GitHub App installation token. It
deduplicates comment IDs, validates the commenter's repository permission, and
accepts only `benchmarks run <suite>/<variant>` commands. Polling keeps the EC2
instance private with no inbound internet listener.

## Job sequence

1. Resolve and persist the PR base SHA and head SHA.
2. Create isolated worktrees for both immutable SHAs.
3. Build the base worker in a credential-free container using persistent Cargo
   caches.
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

- Do not expose EC2 instance metadata, AWS credentials, GitHub credentials, the
  host filesystem, or a container-engine socket to build containers.
- Keep GitHub and deployment credentials in the controller process only.
- Give the controller a dedicated least-privilege AWS role scoped to the bot
  cluster and artifact prefix.
- Give benchmark pods only dataset-read permission.
- Never execute scripts or Helm charts from the pull request. Use the bot's
  pinned deployment and benchmark harness; consume only the built worker
  artifact.
- Restrict triggers to trusted repository roles and keep an auditable job
  record.

## Cache strategy

Start with persistent EBS-backed Cargo registry, Git, and target directories.
Use separate source worktrees but one serialized `CARGO_TARGET_DIR`, allowing
the base and head builds to reuse dependency artifacts. Add `sccache` only after
measuring cache misses; an S3 cache is useful for instance replacement but is
not required for the first implementation.

## Failure behavior

Persist every state transition before performing the corresponding external
action. A restarted controller resumes or fails the current job explicitly. A
deployment or benchmark interruption never advances to the next side. Post one
terminal GitHub comment with the failing phase and retain enough logs for
diagnosis.
