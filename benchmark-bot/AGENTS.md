# DataFusion Distributed benchmark bot agent guide

## Architecture boundaries

- Implement the controller, GitHub integration, queue, orchestration, result
  rendering, and Pulumi infrastructure in TypeScript.
- Treat pull-request source, Cargo build scripts, and built workers as
  untrusted.
- Never expose GitHub or AWS credentials to a PR build process.
- Use immutable base and head SHAs persisted when the comment is accepted.
- Keep every job's Helm resources isolated from interactive benchmark releases.
- Use the bundled `datafusion-deploy.cjs` and `datafusion-destroy.cjs` entry
  points for lifecycle operations. Keep the executor arguments, application
  archive, and `benchmarks-remote` bundle build in sync; the controller does not
  install development dependencies or run TypeScript source at runtime.
- Keep the bot's EKS cluster and artifact prefixes separate from interactive
  remote benchmarks.
- Treat the EKS foundation as human-managed external infrastructure. Bot IaC may
  provision the persistent controller, but must not create, update, or destroy
  EKS, VPC, subnet, node, namespace, or pod-identity resources.

## Commands

Local operations use `bot-deploy`, `bot-destroy`, `bot-outputs`, and
`bot-session`, with TypeScript entry points under `src/bin/`. All default to
the `controller` Pulumi stack and accept `--stack`; session access uses AWS SSM.
Keep root npm forwarding and README examples in sync with these commands.

```bash
npm run format:check
npm run build
npm test
```

Do not add account IDs, profile names, private keys, generated state, or runtime
credentials to the repository.
