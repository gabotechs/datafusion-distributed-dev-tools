---
name: remote-datasets
description: Consume datasets for the DataFusion Distributed remote benchmark foundation. Use when an agent needs to list what has finished generating in the dataset bucket, inspect S3 dataset layouts, or explain upstream dataset preparation. This repository does not generate or remove datasets.
---

# Remote Datasets

Operate from `benchmarks-remote`. Resolve the bucket from the foundation outputs; never guess its name.

## Authenticate

1. Use the caller-selected `AWS_PROFILE`. Pass `--region <region>` to project commands when operating outside their `us-east-1` default; use `AWS_REGION` or `--region` for direct AWS CLI calls. Never hardcode an account, profile, or `aws-vault` wrapper.
2. Run `aws sts get-caller-identity` before a mutating operation.
3. If SSO has expired and `AWS_PROFILE` is set, run `aws sso login --profile "$AWS_PROFILE"` once. Stop and request authentication if it does not succeed.

## Prepare and consume datasets

Dataset generation belongs to the DataFusion Distributed source checkout. Use its `dfbench prepare-*` commands with `--root s3://<dataset-bucket>` and wait for completion before benchmarking. See the dataset lifecycle examples in `benchmarks-remote/README.md`.

Treat dataset names as literal S3 prefixes: the full parameter-encoded path `prepare-*` prints, minus the bucket, for example `tpch_parquet/scale_factor=10/max_file_size=134217728/dictionary=pages/sorted=false` or `clickbench_parquet/partition_start=0/partition_end=100`. Do not invent aliases such as `tpch_sf10`. The benchmark harness discovers table formats from S3 listings and reads SQL queries from the source checkout's fixed `testdata/<suite>/queries` directory. A local dataset copy is not required.

Iceberg datasets must be generated at their final S3 location. The source project writes their metadata and manifests; this repository must not copy local datasets to S3 or rewrite embedded paths. Regenerating an existing, complete dataset path is a no-op (the source project marks it with `_SUCCESS`); do not create additional readiness markers. Benchmark execution assumes the requested dataset has finished generation.

## List available datasets

Check what has finished generating in the bucket (by its `_SUCCESS` marker) before requesting a benchmark against it:

```bash
npm run list-datasets
```

This repository does not generate, upload, or remove datasets; do that from the source checkout or directly in S3.

## Validate changes

When changing dataset tooling, run:

```bash
npm run build
npm test
```
