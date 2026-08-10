# Remote benchmarks

This directory contains the local benchmark clients and the infrastructure used
to run distributed benchmarks on Kubernetes.

- `src/` contains the local TypeScript benchmark clients.
- `pulumi/` provisions the AWS and EKS foundation.
- `k8s/` contains the engine charts and lifecycle scripts.
- `engines/` contains engine-specific runtime sources.

## Source checkout

`datafusion-distributed-dev-tools` expects the DataFusion Distributed source
repository to be checked out beside it. Datasets and benchmark queries are read
from that source checkout's `testdata/` directory:

```text
<parent>/
  datafusion-distributed/
    testdata/
  datafusion-distributed-dev-tools/
    benchmarks-remote/
```

For a source worktree elsewhere, set `DATAFUSION_DISTRIBUTED_ROOT` to that
checkout. `BENCHMARK_TESTDATA_ROOT` is a more specific override for a custom
testdata directory. Relative source-checkout paths are resolved from the
`datafusion-distributed-dev-tools` root:

```bash
DATAFUSION_DISTRIBUTED_ROOT=../datafusion-distributed-pr \
  npm run sync-bucket -- --dataset tpch/sf1
```

The foundation, engine workloads, datasets, and benchmark runs have independent
lifecycles. Benchmark commands never provision infrastructure, install engines,
upload datasets, or remove workloads.

## AWS authentication

The commands use the caller's AWS CLI credentials. For an AWS SSO profile,
authenticate and select it before running any npm or kubectl command:

```bash
export AWS_PROFILE=<your-sso-profile>
export AWS_REGION=us-east-1
aws sso login
aws sts get-caller-identity
```

Add the two `export` lines to `~/.zshrc` to make that profile and region the
defaults for new zsh sessions. SSO sessions still expire, so rerun
`aws sso login` when AWS reports missing or expired credentials.

## Foundation lifecycle

Install dependencies and create the EKS cluster, buckets, registries, IAM
resources, and Kubernetes tenancy:

```bash
npm install
npm run foundation-deploy
```

The foundation remains deployed until it is explicitly destroyed:

```bash
npm run foundation-destroy
```

Foundation destruction removes all stack-owned resources, including datasets,
results, and published engine artifacts.

## Dataset lifecycle

List and upload local datasets independently from engines and benchmark runs:

```bash
npm run sync-bucket -- --list
npm run sync-bucket -- --dataset tpch/sf1
npm run sync-bucket -- --dataset tpch/sf1 tpcds/sf10
```

Running `npm run sync-bucket` without `--dataset` uploads every locally
available benchmark dataset. Delete selected datasets explicitly with:

```bash
npm run dataset-destroy -- --dataset tpch/sf1 --yes
```

Dataset names are paths relative to the sibling source checkout's `testdata/`,
such as `tpch/sf10` or `clickbench/0-100`.

Dataset sync and destroy commands can be rerun after interruption to converge
the contents stored in S3.

## Engine lifecycle

Deploy only the engines needed for a benchmark session:

```bash
npm run datafusion-deploy
npm run trino-deploy
npm run spark-deploy
npm run ballista-deploy
```

Each deploy command publishes any required engine artifacts and installs or
updates that engine's Helm release. The release and its EKS capacity remain
running across benchmark invocations until explicitly destroyed:

```bash
npm run datafusion-destroy
npm run trino-destroy
npm run spark-destroy
npm run ballista-destroy
```

Helm upgrades are atomic and clean up failed revisions. Content-addressed
artifacts and local deployment metadata are also written atomically, so an
interrupted deploy can be rerun safely. Engine and foundation destroy commands
are idempotent and can likewise be rerun after interruption.

## Running benchmarks

An engine and the requested dataset must already be deployed. Benchmark commands
only open a local Kubernetes port-forward and execute the local client:

```bash
npm run datafusion-bench -- --dataset tpch/sf1 --iterations 1
npm run trino-bench -- --dataset tpch/sf1 --iterations 1
npm run spark-bench -- --dataset tpch/sf1 --iterations 1
npm run ballista-bench -- --dataset tpch/sf1 --iterations 1
```

`--iterations` and `--time-secs` are both minimums. For example,
`--iterations 5 --time-secs 10` runs each query until it has completed at least
five measured iterations and at least ten seconds of measured wall-clock time.
Warmup is excluded from both minimums. Comparisons use the p50 latency for each
query and sum those per-query p50 values for `TOTAL`.

`npm run command -- <engine> <command>` runs a diagnostic command in a worker
pod. `npm run compare` compares locally stored result sets.

### Interrupting a run

Benchmark runs can be stopped with `Ctrl-C` or by terminating the local
command. The runner stops its port-forward before exiting. Results from the
previous completed run remain available when a benchmark is interrupted before
it writes new results.

Benchmark results remain under the dataset's local `.results-remote/` directory
and are not uploaded to S3.

## Kubectl access

The lifecycle scripts keep their kubeconfig at `k8s/.kubeconfig`. From this
directory, use it with normal kubectl commands:

```bash
export KUBECONFIG="$PWD/k8s/.kubeconfig"
kubectl get nodes
```

To add the cluster to the default user-wide kubeconfig instead, run:

```bash
aws eks update-kubeconfig --region us-east-1 --name datafusion-bench-eks
```

See [`pulumi/README.md`](./pulumi/README.md) for foundation details and
[`k8s/README.md`](./k8s/README.md) for Kubernetes workload details.
