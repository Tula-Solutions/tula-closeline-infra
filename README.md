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
CI.

A service spec carries four kinds of configuration, each with one source per variable name (Zod
rejects a collision, and `ENVIRONMENT` is reserved):

- `environment`: non-secret settings, passed as plain container values.
- `secrets`: secret variable names only. Each is read from the existing Secrets Manager secret
  `closeline/<environment>/<service>/<NAME>` (`secretName` in `lib/config.ts`) and passed as an
  ECS secret. The stacks never create or read a value; the owner creates it as a plain string.
- `queues`: a queue from the stage, its URL variable and its grant (`send`, `consume`, `both`).
- `storage`: the data stack's bucket name under the given variable; the task role gets
  `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on objects under `keyPrefix` (default: the
  whole bucket) and `s3:ListBucket` on the bucket (key names only; a prefix condition would not apply to a head request), so a missing key is a 404, not a 403.

The bucket and the Postgres endpoint reach the service stack as typed props. Core reads only
`DATABASE_URL`, a full `postgres://` URL with credentials, so it is an owner-created secret and the
host and port are published as the service stack's `DatabaseHost` and `DatabasePort` outputs.

### Routing rule for `/v1/*`

The ALB has one listener and a path belongs to one service. Each service claims its own
`/v1/<prefix>/*` patterns, or, where a prefix is shared, a priority order: the lower number is
tried first, so specific patterns get the lower numbers and a catch-all such as core's `/v1/*` the
highest. Settle this before auth or the playbook join a stage; `/healthz`, `/readyz` and
`/internal` are never routed.

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
4. **Create the secrets** each service lists in `config/stages.ts` in Secrets Manager, named
   `closeline/<environment>/<service>/<NAME>` (for dev core: `DATABASE_URL`,
   `INTERNAL_API_TOKENS`, `DEMO_RATE_KEY`, `CONSENT_HASH_KEY`). Values never go in this repo.
   Also replace the placeholder auth, portal and notice hosts in the stage's `environment`.
5. Run the **Deploy** workflow (Actions, Deploy, Run workflow) and pick the stage. It runs
   `cdk diff`, then `cdk deploy`.
