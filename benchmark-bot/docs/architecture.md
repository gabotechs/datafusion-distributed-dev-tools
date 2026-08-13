# Architecture

## Components

### Controller and builder

A single persistent EC2 instance runs the controller. Its EBS volume contains:

- the SQLite queue and deduplication state;
- one `datafusion-distributed` checkout adjacent to the installed development
  tools project; and
- a conventional persistent Cargo home and target directory.

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
`benchmarks run <suite>/<variant>... [--instance-type <type>] [--nodes <count>]`
commands. Omitted capacity uses the upstream defaults of `c5n.2xlarge` and 12
nodes. It validates every dataset and the instance-type token, rejects duplicate
datasets, and limits requests to 24 nodes. Polling keeps the EC2 instance
private with no inbound internet listener. GitHub authentication is not managed
by Pulumi.

## Job sequence

1. Validate and persist the ordered dataset list, requested instance type, and
   node count together with the PR base SHA and head SHA. Create one GitHub
   status comment and persist its ID for all subsequent progress updates.
2. Fetch and check out the immutable base SHA in the persistent adjacent source
   clone.
3. Validate every requested dataset against S3 and recreate its local table
   placeholders under that checkout's normal `testdata/` tree.
4. Run `DEPLOYMENT_NAME=datafusion-benchmark-bot npm run datafusion-deploy`
   from `benchmarks-remote`. The shared command builds the checked-out
   `benchmarks` crate's `worker` binary, publishes it, installs the named Helm
   release, and waits for it to become ready.
5. Run every requested dataset against the base deployment in order and retain
   its local results.
6. Fetch and check out the immutable head SHA in the same source clone, then run
   the same named deployment command to upgrade the release.
7. Run the same ordered dataset list against the head deployment, combine the
   comparison stdout, and update the existing status comment in place.
8. Run the shared `datafusion-destroy` command for the bot-owned deployment.

## Security boundary

Treat pull-request code as untrusted even when a maintainer requests the run.
Cargo build scripts and the resulting worker can execute arbitrary code.

- Run fetch and compilation as the separate `benchmark-build` account. It cannot
  read the controller's environment file or `GH_TOKEN`.
- Block EC2 metadata during dependency fetch. Run compilation with networking
  disabled, the source tree read-only, and only the shared Cargo cache writable.
- Keep GitHub and deployment credentials in the controller process only.
- Give the controller a dedicated least-privilege AWS role scoped to describing
  the configured cluster, listing the dataset bucket, reading its application,
  and reading or writing only worker artifacts.
- Give benchmark pods only dataset-read permission.
- Never execute scripts or Helm charts from the pull request. Use the trusted
  deployment and benchmark harness bundled with the controller. The Rust worker
  target is part of the untrusted DataFusion Distributed source and runs only
  inside the isolated build and benchmark environments.
- Restrict triggers to trusted repository roles and keep an auditable job
  record.

## Cache strategy

Use the same persistent EBS-backed Cargo home and target directory for the
serialized base and head deployments. This matches a normal local checkout and
lets Cargo perform its own incremental reuse. Add `sccache` only after measuring
cache misses.

## Failure behavior

Persist every state transition before performing the corresponding external
action. A restarted controller retries an interrupted job at most three times,
then fails it terminally. A deployment or benchmark interruption never advances
to the next side. Public comments contain only generic failure context; full
command output remains in the protected controller journal.
