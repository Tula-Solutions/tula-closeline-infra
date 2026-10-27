import type { RegionConfigInput } from '../lib/config'

/** Everything about a stage except the AWS account, which comes from context or the environment. */
export type StageDefinition = Omit<RegionConfigInput, 'account'>

/** What differs by environment in size: the database's AZ spread and how services scale. */
interface Sizing {
  multiAz: boolean
  /** Applied to every service that does not set its own `autoscaling`; none means a fixed count. */
  autoscaling?: { minCount: number; maxCount: number; cpuTargetPercent: number }
}

/** Sizing per environment. Dev is the small single-AZ stack; staging and prod spread and scale. */
export const sizing: Record<StageDefinition['environment'], Sizing> = {
  dev: { multiAz: false },
  staging: { multiAz: true, autoscaling: { minCount: 2, maxCount: 4, cpuTargetPercent: 60 } },
  prod: { multiAz: true, autoscaling: { minCount: 2, maxCount: 10, cpuTargetPercent: 60 } },
}

/** Fills a stage definition with its environment's sizing; anything the stage sets itself wins. */
export function applySizing(definition: StageDefinition): StageDefinition {
  const size = sizing[definition.environment]
  const { autoscaling } = size
  return {
    multiAz: size.multiAz,
    ...definition,
    services: definition.services?.map((service) =>
      autoscaling ? { desiredCount: autoscaling.minCount, autoscaling, ...service } : service
    ),
  }
}

/**
 * The stages this app can deploy, one per Region. Add a queue to `queues` and a service to
 * `services` here; stacks and grants follow from the entries.
 */
export const stages: Record<string, StageDefinition> = {
  dev: {
    region: 'us-east-1',
    environment: 'dev',
    natGateways: 1,
    queues: [
      // Core's bulk jobs. A job may run up to a few minutes, so the visibility timeout must
      // outlast it (3 minutes) or a second consumer would take the message mid-run.
      { name: 'core-jobs', visibilityTimeoutSeconds: 180 },
      // Core's domain events (`QUEUE_URL`). Default visibility timeout: a handler is short.
      { name: 'core-events' },
    ],
    services: [
      {
        name: 'core',
        // Placeholders until core's CI pushes an image; deploying needs the real repository and tag.
        repositoryName: 'closeline/core',
        imageTag: 'placeholder',
        // Only /v1/* is routed. The listener's default action is a 404, which keeps /healthz,
        // /readyz and /internal (service to service) unreachable through the load balancer.
        // Rule for /v1 overlaps: a path belongs to one service. When auth or the playbook join,
        // each gets its own /v1/<prefix>/* patterns and a priority below core's, and core's
        // catch-all /v1/* keeps the highest number so the specific rules are tried first.
        pathPatterns: ['/v1/*'],
        healthCheckPath: '/healthz',
        priority: 100,
        queues: [
          { queue: 'core-events', envName: 'QUEUE_URL', access: 'both' },
          { queue: 'core-jobs', envName: 'JOBS_QUEUE_URL', access: 'both' },
        ],
        // Core's import files; the bucket name arrives as STORAGE_BUCKET. keyPrefix mirrors the
        // kit's S3_KEY_PREFIX: its S3 adapter stores every key under `orgs/`.
        storage: { envName: 'STORAGE_BUCKET', keyPrefix: 'orgs/' },
        // The stage's CRM token key (alias/closeline/dev/core/crm-tokens); its ARN arrives as
        // CRM_TOKEN_KMS_KEY_ARN. Core's adapter must pass the encryption context
        // {"closeline:service": "core"} on every call (the grant is conditional on it).
        kmsKey: { envName: 'CRM_TOKEN_KMS_KEY_ARN' },
        // Secret names are closeline/dev/core/<NAME> (see `secretName` in lib/config.ts). An owner
        // creates each in Secrets Manager as a plain string; no value is in this repo.
        // DATABASE_URL is a full postgres:// URL with the closeline_core login; core reads no
        // separate host or port, so the endpoint is only published as a stack output.
        secrets: ['DATABASE_URL', 'INTERNAL_API_TOKENS', 'DEMO_RATE_KEY', 'CONSENT_HASH_KEY'],
        // Non-secret settings. PLACEHOLDER: the auth, portal and notice values below name hosts
        // that do not exist yet; set the real ones before the first deploy.
        environment: {
          REGION: 'us',
          AWS_REGION: 'us-east-1',
          AUTH_JWKS_URL: 'https://auth.dev.closeline.example/.well-known/jwks.json',
          AUTH_ISSUER: 'https://auth.dev.closeline.example',
          AUTH_AUDIENCE: 'closeline',
          PORTAL_BASE_URL: 'https://portal.dev.closeline.example',
          // One proxy (the ALB) appends to X-Forwarded-For.
          TRUSTED_PROXY_HOPS: '1',
          DEMO_NOTICE_TO: 'demo-requests@closeline.example',
        },
      },
    ],
  },
}
