# DataFusion Distributed development tools

This repository contains the remote benchmark platform and pull-request
benchmark automation for
[DataFusion Distributed](https://github.com/datafusion-contrib/datafusion-distributed).

It has two independently operated components:

- [`benchmarks-remote/`](benchmarks-remote/README.md) provisions the shared EKS
  foundation, manages datasets and engine deployments, and runs benchmarks
  from a developer machine.
- [`pr-bot/`](pr-bot/README.md) provisions a persistent EC2 controller that
  accepts trusted GitHub PR comments, builds immutable base and head revisions,
  runs isolated benchmark deployments on the existing EKS foundation, and
  reports the comparison.

The PR bot does not own the EKS foundation. A human provisions the foundation
from `benchmarks-remote/` and gives the controller narrowly scoped access to
use it. Both components live in this repository so the trusted benchmark
harness can evolve independently of DataFusion Distributed source revisions.

## Checkout layout

Keep this repository beside a DataFusion Distributed source checkout. The
remote benchmark commands read datasets and queries from the source checkout's
`testdata/` directory.

```text
<parent>/
  datafusion-distributed/
  datafusion-distributed-dev-tools/
```

Set `DATAFUSION_DISTRIBUTED_ROOT` when running commands against a source
worktree outside this default layout.

## Development

Install each component's dependencies:

```bash
npm run install:all
```

Validate both components from the repository root:

```bash
npm run build
npm test
```

Root npm commands forward operational commands to the owning component. For
example:

```bash
npm run foundation-deploy
npm run sync-bucket -- tpch/sf1
npm run datafusion-deploy
npm run datafusion-bench -- tpch/sf1 --service datafusion --iterations 1
npm run controller-deploy
npm run controller-ssh
```

Foundation, dataset, engine, benchmark, and controller teardown remain
explicit operations. See each component's README before operating live
infrastructure.
