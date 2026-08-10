# DataFusion Distributed PR benchmark bot

This service listens for trusted pull-request comments in the form:

```text
benchmarks run tpch/sf1
```

For each request it benchmarks the pull request's immutable base SHA, deploys
the pull request head SHA to a dedicated EKS benchmark cluster, repeats the same
workload, and posts the comparison to the pull request.

## Architecture

- A persistent EC2 controller serializes jobs and keeps its Git mirror, Cargo
  registry, and Rust build artifacts on an EBS volume.
- Builds run in credential-free containers. The trusted controller uploads the
  resulting worker binary and performs Kubernetes operations.
- The bot uses its own EKS foundation. It never deploys to the cluster used by
  interactive benchmark sessions.
- SQLite on EBS stores seen comments and job state. GitHub remains the
  user-facing source of requests and results.
- Only trusted repository users can enqueue work.

The persistent machine may be stopped when idle without losing its EBS cache.
Benchmark worker nodes remain managed by EKS Auto Mode and scale independently.

See [docs/architecture.md](docs/architecture.md) for the execution and security
boundaries.

## Development

```bash
npm install
npm run build
npm test
```
