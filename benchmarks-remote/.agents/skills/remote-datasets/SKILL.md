---
name: remote-datasets
description: Manage datasets for the DataFusion Distributed remote benchmark foundation. Use when an agent needs to inspect S3 dataset layouts, explain upstream dataset preparation, or explicitly remove a remote dataset.
---

# Remote Datasets

Operate from `benchmarks-remote`. Resolve the bucket from the foundation outputs; never guess its name.

## Authenticate

1. Use the caller-selected `AWS_PROFILE` and `AWS_REGION`; never hardcode an account, profile, or `aws-vault` wrapper.
2. Run `aws sts get-caller-identity` before a mutating operation.
3. If SSO has expired and `AWS_PROFILE` is set, run `aws sso login --profile "$AWS_PROFILE"` once. Stop and request authentication if it does not succeed.

## Prepare and consume datasets

Dataset generation belongs to the DataFusion Distributed source checkout. Use its preparation commands with `--output s3://<dataset-bucket>/<dataset>` and wait for completion before benchmarking. See the dataset lifecycle examples in `benchmarks-remote/README.md`.

Treat dataset names as literal S3 prefixes, for example `tpch/sf10` or `clickbench/0-100`. Do not invent aliases such as `tpch_sf10`. The benchmark harness discovers table formats from S3 listings and reads SQL queries from the source checkout. A local dataset copy is not required.

Iceberg datasets must be generated at their final S3 location. The source project writes their metadata and manifests; this repository must not copy local datasets to S3 or rewrite embedded paths. Do not create additional readiness markers. Benchmark execution assumes the requested dataset has finished generation.

## Remove datasets

Dataset removal is destructive. Resolve the exact dataset name and obtain explicit authorization before running:

```bash
npm run dataset-destroy -- tpch/sf10 --yes
```

This removes only the selected S3 prefix. It does not remove local `testdata/`, engine deployments, or the foundation.

## Validate changes

When changing dataset tooling, run:

```bash
npm run build
npm test
```
