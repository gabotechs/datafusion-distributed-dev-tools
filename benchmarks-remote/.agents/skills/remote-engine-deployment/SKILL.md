---
name: remote-engine-deployment
description: Manage persistent Kubernetes deployments for the DataFusion, Trino, Spark, Ballista, and ClickHouse remote benchmark engines. Use when an agent needs to publish engine code or images, deploy or update an engine, inspect its Helm release and pods, run a diagnostic command, recover an interrupted deployment, or explicitly tear down an engine.
---

# Remote Engine Deployment

Operate from `benchmarks-remote`. Supported engine names are `datafusion`, `trino`, `spark`, `ballista`, and `clickhouse`.

## Preconditions

1. Use the caller-selected `AWS_PROFILE`. Pass `--region <region>` to project commands when operating outside their `us-east-1` default; use `AWS_REGION` or `--region` for direct AWS CLI calls. Never hardcode an account, profile, or `aws-vault` wrapper.
2. Run `aws sts get-caller-identity`. If SSO has expired and `AWS_PROFILE` is set, run `aws sso login --profile "$AWS_PROFILE"` once; stop if authentication still fails.
3. Require `pulumi/.pulumi-outputs.json`. If it is missing, report that the foundation must be deployed; do not deploy it implicitly.

## Deploy or update

Each engine has its own `src/bin/<engine>-deploy.ts` and
`src/bin/<engine>-destroy.ts`, with shared mechanics in `src/lib/deployment.ts`.
The npm command fixes the engine; do not supply a positional engine argument.
Inspect its Optique options with `npm run <engine>-deploy -- --help` or
`npm run <engine>-destroy -- --help`.

Run the selected engine command:

```bash
npm run datafusion-deploy
npm run trino-deploy
npm run spark-deploy
npm run ballista-deploy
npm run clickhouse-deploy
```

Deploy commands publish content-addressed artifacts when required and perform an atomic Helm install or upgrade. DataFusion and Ballista publish Linux binaries, Spark publishes an ECR image through CodeBuild, and Trino and ClickHouse use their chart images directly. Rerun the same deploy command after interruption.

Keep the default 12 measured workers. Do not set `--nodes` or alter `worker-resources.yaml` unless the user requests a different benchmark shape. Every measured worker must use the shared node-filling resource configuration and one worker per benchmark node.

Deployment is persistent. Do not destroy the engine after deployment unless teardown was requested.

## Inspect and diagnose

Use the generated kubeconfig:

```bash
export KUBECONFIG="$PWD/k8s/.kubeconfig"
helm list --all-namespaces
kubectl get pods --namespace benchmark-<engine> -o wide
kubectl get nodes -o wide
```

Run a diagnostic command in a worker with:

```bash
npm run command -- <engine> -- <command> [arguments...]
```

Prefer pod status, events, and relevant container logs when a Helm readiness wait fails. Do not add permanent health-check orchestration to the deployment scripts.

## Destroy

Engine teardown is explicit and leaves the foundation and datasets intact:

```bash
npm run datafusion-destroy
npm run trino-destroy
npm run spark-destroy
npm run ballista-destroy
npm run clickhouse-destroy
```

Resolve the exact engine and release, and obtain authorization before teardown.
Use `--deployment-name <name>` for a named release. Stop benchmark readers of
that release first; teardown does not check a benchmark lock.

Helm inherits `HELM_DRIVER` from the caller. Use the backend that owns the
release for both inspection and teardown; secrets and ConfigMaps contain
independent release records. If pods remain after a successful command, check
for a backend mismatch: `--ignore-not-found` makes a missing release a no-op.
For a release stored in secrets, use:

```bash
HELM_DRIVER=secret helm list --all-namespaces
HELM_DRIVER=secret npm run datafusion-destroy -- --deployment-name my-worker
```

Verify that the selected release's deployment and pods are removed. Pods may
remain terminating briefly, and EKS Auto Mode removes empty capacity
asynchronously.

## Validate changes

Render every affected Helm chart with `k8s/worker-resources.yaml`, type-check changed TypeScript commands, and run `npm test`. For runtime changes, deploy the affected engine and leave it installed unless teardown is part of the request.
