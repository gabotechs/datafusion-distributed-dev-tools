# DataFusion Distributed PR bot agent guide

## Architecture boundaries

- Implement the controller, GitHub integration, queue, orchestration, result
  rendering, and Pulumi infrastructure in TypeScript.
- Treat pull-request source, Cargo build scripts, and built workers as
  untrusted.
- Never expose GitHub or AWS credentials to a PR build container.
- Use immutable base and head SHAs persisted when the comment is accepted.
- Serialize jobs until the benchmark harness explicitly supports independent
  clusters per concurrent run.
- Keep the bot's EKS cluster and artifact prefixes separate from interactive
  remote benchmarks.

## Commands

```bash
npm run format:check
npm run build
npm test
```

Do not add account IDs, profile names, private keys, generated state, or runtime
credentials to the repository.
