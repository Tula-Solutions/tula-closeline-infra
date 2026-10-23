import type { RegionConfigInput } from '../lib/config'

/** Everything about a stage except the AWS account, which comes from context or the environment. */
export type StageDefinition = Omit<RegionConfigInput, 'account'>

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
    ],
    services: [
      {
        name: 'core',
        // Placeholders until core's CI pushes an image; deploying needs the real repository and tag.
        repositoryName: 'closeline/core',
        imageTag: 'placeholder',
        // Only /v1/* is routed. The listener's default action is a 404, which keeps /healthz,
        // /readyz and /internal (service to service) unreachable through the load balancer.
        // /v1/* will overlap auth's and the playbook's /v1 prefixes: settle their patterns and
        // priorities when those services are added.
        pathPatterns: ['/v1/*'],
        healthCheckPath: '/healthz',
        priority: 100,
        queues: [{ queue: 'core-jobs', envName: 'JOBS_QUEUE_URL', access: 'both' }],
      },
    ],
  },
}
