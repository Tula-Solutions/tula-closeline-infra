import { z } from 'zod'

/** The deployment environments; the `ENVIRONMENT` variable every service reads (never NODE_ENV). */
export const environmentSchema = z.enum(['dev', 'staging', 'prod'])

const queueSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  visibilityTimeoutSeconds: z.number().int().min(0).max(43200).default(30),
})

const queueAccessSchema = z.object({
  queue: z.string(),
  envName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  access: z.enum(['send', 'consume', 'both']),
})

const secretRefSchema = z.object({
  envName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  secretName: z.string().min(1),
  field: z.string().optional(),
})

/** One Closeline service to run: where its image lives, how it is routed and what it may use. */
export const serviceSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  /** ECR repository name, referenced not created. The image is pushed by the service's own CI. */
  repositoryName: z.string().min(1),
  imageTag: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3000),
  cpu: z.number().int().default(256),
  memoryMiB: z.number().int().default(512),
  desiredCount: z.number().int().min(0).default(1),
  pathPatterns: z.array(z.string().startsWith('/')).min(1),
  healthCheckPath: z.string().startsWith('/').default('/health'),
  /** ALB listener rule priority, unique per listener. */
  priority: z.number().int().min(1).max(50000),
  queues: z.array(queueAccessSchema).default([]),
  secrets: z.array(secretRefSchema).default([]),
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
