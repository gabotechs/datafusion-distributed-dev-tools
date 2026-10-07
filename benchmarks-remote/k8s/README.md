# Kubernetes engine workloads

Kubernetes hosts persistent engine services. Benchmark clients run on the
developer machine through the npm commands in `benchmarks-remote/package.json`.

Create the foundation before managing engines:

```bash
npm run foundation-deploy
```

Engine deploy commands publish required artifacts, install or update the Helm
release, and wait for it to become ready. For example:

```bash
npm run datafusion-deploy
npm run datafusion-bench -- tpch/sf1 --iterations 1
npm run datafusion-destroy
```

Pass `--deployment-name <name>` with both commands to deploy an independently named
DataFusion release.

Benchmark commands require the engine release and dataset to exist. They do not
run Helm, upload datasets, or uninstall the engine. Deployments continue to use
EKS capacity between runs until their corresponding `<engine>-destroy` command
is invoked.

All measured worker and executor pods load
[`worker-resources.yaml`](./worker-resources.yaml). They request and limit the
same 7 CPUs and 17 GiB of memory, reserving the available benchmark capacity of
one `c5n.2xlarge` node per pod while leaving capacity for Kubernetes system
overhead. Every engine defaults to 12 worker replicas. Engine coordinators run
on the separate system-node type and are not part of the measured worker
capacity. ClickHouse has no separate coordinator: every worker belongs to the
`benchmark` cluster, and the `clickhouse` service sends queries to the first
worker. The ClickHouse client replaces each table in a query with an
`s3Cluster` read, so every worker scans Parquet files and applies filters and
partial aggregation. ClickHouse joins those reads on the first worker, and runs
queries with correlated subqueries through per-table views. The deployment uses
default ClickHouse settings apart from standard SQL semantics and has no
filesystem cache, so every query reads from S3.

The scripts use `k8s/.kubeconfig`. Export it to connect directly:

```bash
export KUBECONFIG="$PWD/k8s/.kubeconfig"
kubectl get pods --all-namespaces
```

Destroy the complete AWS foundation only when its buckets, registries, results,
and cluster should also be removed:

```bash
npm run foundation-destroy
```

Deploy and destroy commands accept `--region`, `--outputs-file`, `--kubeconfig`,
and `--refresh-kubeconfig`. Deploy commands also accept `--nodes` and
`--instance-type`. DataFusion accepts `--worker-cpu` and `--worker-memory`
together, `--source-root`, `--target-dir`, `--artifact-bucket`,
`--artifact-prefix`, `--build-wrapper`, and `--worker-artifact`.
Ballista accepts `--target-dir` for its build artifacts.
Spark accepts `--spark-image` to deploy an existing image. Each engine's deploy
and destroy commands invoke separate TypeScript entry points under `src/bin/`.
Destroy commands accept only connection options and `--deployment-name`;
run any command with `--help` for its options.

```bash
npm run datafusion-deploy -- --deployment-name my-worker --nodes 12
npm run datafusion-bench -- tpch/sf1 --k8s-service my-worker
npm run datafusion-destroy -- --deployment-name my-worker
npm run command -- --region us-east-1 datafusion -- df -h
npm run test-render
```

Publish artifacts independently with `npm run publish-datafusion`,
`npm run publish-ballista`, or `npm run publish-image -- spark`.
Application options are command-line arguments; AWS authentication and
standard Cargo/Zig settings use the caller's tool configuration.

Helm also inherits the caller's `HELM_DRIVER`, which defaults to `secret` when
unset. Use the same storage backend for deployment, inspection, and teardown.
A release stored in secrets is invisible to the `configmap` backend, and an
uninstall with `--ignore-not-found` can succeed without removing its pods.
To inspect and remove a release stored in secrets, use:

```bash
HELM_DRIVER=secret helm list --all-namespaces
HELM_DRIVER=secret npm run datafusion-destroy -- --deployment-name my-worker
```

Check the release's namespace and workload names before teardown. Pods may
remain terminating briefly after their deployment is removed; empty EKS nodes
are reclaimed asynchronously.
