# DataFusion Distributed development tools agent guide

## Project purpose

This repository owns remote benchmark infrastructure and automation for
DataFusion Distributed. Keep infrastructure and automation concerns here so
the DataFusion Distributed repository can remain focused on the Rust library
and local benchmarks.

## Repository map

- `benchmarks-remote/`: human-operated AWS/EKS foundation, datasets,
  Kubernetes engine deployments, and local benchmark clients. Follow its
  scoped `AGENTS.md` and operational skills before changing or operating it.
- `benchmark-bot/`: persistent controller infrastructure, GitHub comment handling,
  job queue, source builds, benchmark orchestration, and comparison reporting.
  Follow its scoped `AGENTS.md` before changing it.

## Architecture boundaries

- Keep the benchmark foundation human managed. The benchmark bot consumes an existing
  foundation and must never create, update, or destroy its EKS cluster, VPC,
  nodes, namespaces, datasets, or pod identities.
- Treat pull-request source, Cargo build scripts, and binaries built from them
  as untrusted. Never expose GitHub or AWS credentials to their build process
  or benchmark pods.
- Keep the benchmark harness trusted and versioned in this repository. A pull
  request supplies DataFusion Distributed source, not deployment logic.
- Preserve independent lifecycles for the foundation, datasets, persistent
  interactive engine deployments, benchmark runs, and the benchmark bot controller.
- Prefer TypeScript for orchestration and infrastructure code. Engine adapters
  may use the language required by the engine.
- Do not commit account IDs, profile names, credentials, generated state,
  kubeconfig, or runtime artifact metadata.
- Write documentation for the current system. Do not describe commands or
  behavior by referring to how the project worked previously.

## Validation

Run the narrowest relevant checks first. For a cross-component change, run:

```bash
npm run build
npm test
```
