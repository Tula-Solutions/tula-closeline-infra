import { z } from 'zod'

/** The deployment environments; the `ENVIRONMENT` variable every service reads (never NODE_ENV). */
export const environmentSchema = z.enum(['dev', 'staging', 'prod'])

/** An environment variable name: upper snake case. */
const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/)

const queueSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  visibilityTimeoutSeconds: z.number().int().min(0).max(43200).default(30),
})

const queueAccessSchema = z.object({
  queue: z.string(),
  envName: envNameSchema,
  access: z.enum(['send', 'consume', 'both']),
})

/** Variables the construct sets itself, so a spec may not set them. */
const RESERVED_ENV_NAMES = ['ENVIRONMENT']

/**
 * The Secrets Manager name of one of a service's secrets: `closeline/<environment>/<service>/<NAME>`,
 * where NAME is the environment variable the container reads. An owner creates each secret by this
 * name (its value is the plain string the variable holds); the stacks only reference it and never
 * create or read a value.
 */
export function secretName(environment: string, service: string, name: string): string {
  return `closeline/${environment}/${service}/${name}`
}

/** One Closeline service to run: where its image lives, how it is routed and what it may use. */
export const serviceSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    /** ECR repository name, referenced not created. The image is pushed by the service's own CI. */
    repositoryName: z.string().min(1),
    imageTag: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(3000),
    cpu: z.number().int().default(256),
    memoryMiB: z.number().int().default(512),
    desiredCount: z.number().int().min(0).default(1),
    /**
     * ALB path patterns. The listener holds one rule per service, so a pattern must not be claimed
     * by two services: give each service its own `/v1/<prefix>/*` patterns, or, where one prefix is
     * shared, an explicit priority order (the lower number wins, the more specific pattern first).
     * Core's `/v1/*` is the catch-all today; narrow it, or give it the highest number, before the
     * auth or playbook service joins the stage.
     */
    pathPatterns: z.array(z.string().startsWith('/')).min(1),
    healthCheckPath: z.string().startsWith('/').default('/health'),
    /** ALB listener rule priority, unique per listener. */
    priority: z.number().int().min(1).max(50000),
    queues: z.array(queueAccessSchema).default([]),
    /** Environment variable that carries the data stack's bucket name; grants object access to it. */
    storage: z
      .object({
        envName: envNameSchema,
        /** Key prefix the grants are limited to, ending in `/`. Default: the whole bucket. */
        keyPrefix: z
          .string()
          .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/)
          .optional(),
      })
      .optional(),
    /**
     * The stage's CRM token KMS key (customer-managed, per stage). Its ARN, not a secret, is passed
     * under `envName`; the task role may only Encrypt, Decrypt and GenerateDataKey with it, and
     * only with the encryption context `closeline:service` equal to the service name.
     */
    kmsKey: z.object({ envName: envNameSchema }).optional(),
    /**
     * Secret environment variable names only. Each is read from the Secrets Manager secret named
     * by `secretName(environment, service, NAME)`; the value is created by an owner, never here.
     */
    secrets: z.array(envNameSchema).default([]),
    /** Non-secret settings, passed as plain container environment values. */
    environment: z.record(envNameSchema, z.string().min(1)).default({}),
  })
  .superRefine((spec, context) => {
    // Every variable name the container receives must come from exactly one source.
    const owners = new Map<string, string>(RESERVED_ENV_NAMES.map((name) => [name, 'reserved']))
    const claim = (name: string, source: string, path: (string | number)[]) => {
      const taken = owners.get(name)
      if (taken !== undefined) {
        context.addIssue({
          code: 'custom',
          path,
          message: `${name} is already used (${taken}); a variable has one source`,
        })
      }
      owners.set(name, source)
    }
    for (const [index, name] of spec.secrets.entries()) {
      claim(name, 'secret', ['secrets', index])
    }
    for (const [index, q] of spec.queues.entries()) {
      claim(q.envName, 'queue', ['queues', index, 'envName'])
    }
    if (spec.storage) {
      claim(spec.storage.envName, 'storage', ['storage', 'envName'])
    }
    if (spec.kmsKey) {
      claim(spec.kmsKey.envName, 'kmsKey', ['kmsKey', 'envName'])
    }
    for (const name of Object.keys(spec.environment)) {
      claim(name, 'environment', ['environment', name])
    }
  })

/** The typed Region config: everything that differs between deployments. */
export const regionConfigSchema = z.object({
  /** Twelve-digit AWS account id, taken from context or `CDK_DEFAULT_ACCOUNT`, never from source. */
  account: z.string().regex(/^\d{12}$/, 'account must be a 12-digit AWS account id'),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'region must look like us-east-1'),
  environment: environmentSchema,
  natGateways: z.number().int().min(1).max(3).default(1),
  /** ACM certificate ARN. When set the ALB serves HTTPS and redirects HTTP. */
  certificateArn: z.string().startsWith('arn:aws:acm:').optional(),
  queues: z.array(queueSpecSchema).default([]),
  services: z.array(serviceSpecSchema).default([]),
})

/** A validated Region config. */
export type RegionConfig = z.infer<typeof regionConfigSchema>
/** A queue to create in the Region. */
export type QueueSpec = z.infer<typeof queueSpecSchema>
/** A service to run in the Region. */
export type ServiceSpec = z.infer<typeof serviceSpecSchema>
/** Config as written, before defaults are applied. */
export type RegionConfigInput = z.input<typeof regionConfigSchema>

/** Validates a Region config and rejects dangling queue references and duplicate priorities. */
export function parseRegionConfig(input: unknown): RegionConfig {
  const config = regionConfigSchema.parse(input)
  if (config.environment !== 'dev' && !config.certificateArn) {
    throw new Error(`${config.environment} needs certificateArn: its load balancer must use HTTPS`)
  }
  const queueNames = new Set(config.queues.map((q) => q.name))
  if (queueNames.size !== config.queues.length) {
    throw new Error('queue names must be unique')
  }
  const priorities = new Set<number>()
  const names = new Set<string>()
  for (const service of config.services) {
    if (names.has(service.name)) {
      throw new Error(`service name ${service.name} is used twice`)
    }
    names.add(service.name)
    if (priorities.has(service.priority)) {
      throw new Error(`listener priority ${service.priority} is used twice`)
    }
    priorities.add(service.priority)
    for (const q of service.queues) {
      if (!queueNames.has(q.queue)) {
        throw new Error(`service ${service.name} uses unknown queue ${q.queue}`)
      }
    }
  }
  return config
}
