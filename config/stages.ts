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
    queues: [],
    services: [],
  },
}
