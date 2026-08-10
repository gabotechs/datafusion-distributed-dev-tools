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
- A human provisions a dedicated remote-benchmark foundation from
  `datafusion-distributed/benchmarks-remote`. This repository consumes its
  cluster and dataset bucket but never creates, updates, or destroys them.
- SQLite on EBS stores seen comments and job state. GitHub remains the
  user-facing source of requests and results.
- Only trusted repository users can enqueue work.

The persistent machine may be stopped when idle without losing its EBS cache.
Benchmark worker nodes remain managed by EKS Auto Mode and scale independently.

See [docs/architecture.md](docs/architecture.md) for the execution and security
boundaries.

## Controller infrastructure

Provision a dedicated benchmark foundation from `datafusion-distributed` before
deploying the controller. Copy these values from that foundation's Pulumi
outputs:

- `clusterName`
- `datasetBucketName`
- `benchmarkInstanceType`
- `benchmarkNodeCount`

Configure the controller stack without storing credentials in the repository:

```bash
pulumi stack init controller
pulumi config set aws:region us-east-1
pulumi config set clusterName your-benchmark-cluster
pulumi config set datasetBucketName your-dataset-bucket
pulumi config set benchmarkInstanceType c5n.2xlarge
pulumi config set benchmarkNodeCount 12
pulumi config set githubRepository datafusion-contrib/datafusion-distributed
pulumi config set sourceRepositoryUrl https://github.com/datafusion-contrib/datafusion-distributed.git
pulumi config set githubAppId your-app-id
pulumi config set githubInstallationId your-installation-id
pulumi config set --secret githubPrivateKey
npm run controller-deploy
```

By default the controller uses a subnet from the account's default VPC. Set
`controllerSubnetId` when it should use another public subnet. The security
group has no inbound rules; administration uses AWS Systems Manager Session
Manager.

The deployment outputs `controllerPublicIp` and `controllerRoleArn`. A human
must add the public IP as a `/32` to the benchmark foundation's
`kubernetesApiAllowedCidrs` and grant the role access to the existing
`benchmark-datafusion` namespace:

```bash
aws eks create-access-entry \
  --cluster-name your-benchmark-cluster \
  --principal-arn arn:aws:iam::YOUR_ACCOUNT:role/YOUR_CONTROLLER_ROLE

aws eks associate-access-policy \
  --cluster-name your-benchmark-cluster \
  --principal-arn arn:aws:iam::YOUR_ACCOUNT:role/YOUR_CONTROLLER_ROLE \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy \
  --access-scope type=namespace,namespaces=benchmark-datafusion
```

These are foundation operations and intentionally remain outside this
repository's Pulumi program. Destroying the controller leaves the EKS cluster,
namespaces, datasets, and benchmark nodes untouched.

## Development

```bash
npm install
npm run build
npm test
```
