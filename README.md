# tula-closeline-infra

Closeline infrastructure: AWS, one full deployment per Region

Part of Closeline. The hub repo [`tula-closeline`](https://github.com/Tula-Solutions/tula-closeline)
holds the glossary, decision records, plans, issues and the shared workflow setup.

## Getting started

```bash
# Once per machine, if you have no SSH key on GitHub: fetch the private tula-closeline-*
# libraries over https with your gh login.
gh auth setup-git
git config --global url."https://github.com/Tula-Solutions/".insteadOf "ssh://git@github.com/Tula-Solutions/"

bun install
bun run verify
```

Standards: `AGENTS.md` (this repo) and `.claude/COMMON.md` (shared).

## How it is built

AWS CDK v2 in TypeScript, run with Bun (hub ADR 0025). `config/stages.ts` lists the stages, one
per Region; `lib/config.ts` validates each with Zod. The account is never in source: it comes from
`-c account=<id>` or `CDK_DEFAULT_ACCOUNT`.

Each stage (`lib/region-stage.ts`) has these stacks:

| Stack | Holds |
| --- | --- |
| `network` | VPC (public, private and isolated subnets) and the ECS cluster |
| `data` | Postgres (RDS) and the object bucket, both retained, encrypted, never public |
| `messaging` | one `QueueWithDlq` per entry of `queues` (only when there is one) |
| `edge` | the internet-facing ALB; unmatched paths get a 404 |
| `service-<name>` | one `CloselineService` per entry of `services`: Fargate service, task role, queue grants, secrets, path rule |

To add a queue or service, add an entry to the stage in `config/stages.ts`. The image is a
reference to an existing ECR repository (`repositoryName`, `imageTag`) pushed by the service's own
CI. Secrets are Secrets Manager names looked up at deploy time and passed to tasks as ECS secrets.

`bun run synth` synthesises every stage with a dummy account (no AWS credentials needed) and is
part of `bun run verify`.

## One-time owner steps

Nobody deploys from a laptop. Until these exist the deploy workflow cannot run.

1. **Bootstrap each account and Region** with an admin identity, once:

   ```bash
   bunx cdk bootstrap aws://<account-id>/<region>
   ```

2. **Create the GitHub OIDC deploy role** in the same account: add the identity provider
   `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`), then a role whose trust
   policy allows `sts:AssumeRoleWithWebIdentity` for
   `repo:Tula-Solutions/tula-closeline-infra:*` (narrow it to the branch or environment you
   deploy from). Give it permission to assume the CDK bootstrap roles (`cdk-*` in the account).
3. **Set repository variables** (Settings, Secrets and variables, Actions, Variables):
   `AWS_DEPLOY_ROLE_ARN` (the role above), `AWS_REGION` (the stage's Region) and `AWS_ACCOUNT_ID`.
4. **Create the secrets** each service names in `config/stages.ts` in Secrets Manager. Values
   never go in this repo.
5. Run the **Deploy** workflow (Actions, Deploy, Run workflow) and pick the stage. It runs
   `cdk diff`, then `cdk deploy`.
