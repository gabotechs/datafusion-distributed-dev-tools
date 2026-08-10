# DataFusion Distributed PR benchmark bot

This service listens for trusted pull-request comments in the form:

```text
benchmarks run tpch/sf1 --instance-type c5n.2xlarge --nodes 12
```

For each request it creates an isolated Kubernetes deployment with the requested
capacity, benchmarks the pull request's immutable base SHA, deploys the pull
request head SHA to the same deployment, repeats the same workload, posts the
comparison, and removes the deployment. Node counts are limited to 24.

## Architecture

- A persistent EC2 controller serializes jobs and keeps its Git mirror, Cargo
  registry, and Rust build artifacts on an EBS volume.
- Rust, Zig, and Cargo build tooling is installed directly on EC2. Untrusted
  compilation runs as a separate OS user in a systemd sandbox; the trusted
  controller uploads the resulting worker binary and performs Kubernetes
  operations.
- A human provisions a dedicated remote-benchmark foundation from
  `datafusion-distributed/benchmarks-remote`. This repository consumes its
  cluster and dataset bucket but never creates, updates, or destroys them.
- SQLite on EBS stores seen comments and job state. GitHub remains the
  user-facing source of requests and results.
- Only trusted repository users can enqueue work.
- A dedicated private S3 bucket separates controller and worker artifacts from
  the human-managed dataset bucket.

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
- the ARN of the foundation's benchmark workload IAM role

Configure the controller stack without storing credentials in the repository:

```bash
pulumi stack init controller
pulumi config set aws:region us-east-1
pulumi config set clusterName your-benchmark-cluster
pulumi config set datasetBucketName your-dataset-bucket
pulumi config set benchmarkWorkloadRoleArn arn:aws:iam::YOUR_ACCOUNT:role/YOUR_BENCHMARK_WORKLOAD_ROLE
pulumi config set githubRepository datafusion-contrib/datafusion-distributed
pulumi config set sourceRepositoryUrl https://github.com/datafusion-contrib/datafusion-distributed.git
npm run controller-deploy
```

By default the controller uses a subnet from the account's default VPC. Set
`controllerSubnetId` when it should use another public subnet. The security
group has no inbound rules; administration uses AWS Systems Manager Session
Manager.

The deployment outputs `controllerPublicIp`, `controllerRoleArn`, and
`artifactBucketName`. A human must add the public IP as a `/32` to the benchmark
foundation's `kubernetesApiAllowedCidrs` and grant the role access to the
existing `benchmark-datafusion` namespace:

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

## GitHub authentication

The controller calls the GitHub REST API directly with a manually provisioned
`GH_TOKEN`. This project does not create a GitHub App or store the token in
Pulumi or AWS Secrets Manager.

After connecting to the controller through Session Manager, edit the protected
service environment file without placing the token in shell history:

```bash
sudoedit /var/lib/datafusion-pr-bot/controller.env
sudo systemctl restart datafusion-pr-bot
sudo systemctl status datafusion-pr-bot
```

Add `GH_TOKEN=...` on its own line. Use a fine-grained personal access token
restricted to the configured repository, with read access to pull requests and
repository metadata and read/write access to issues. The environment file is
mode `0600`; the token is available only to the trusted controller process and
is never forwarded to pull-request builds or benchmark pods.

Replacing the EC2 instance creates a fresh environment file, so the token must
be configured again after replacement.

The controller bundle is compiled before deployment and installed root-owned;
the service does not install development dependencies or transpile TypeScript at
runtime.

## Development

```bash
npm install
npm run build
npm test
```
