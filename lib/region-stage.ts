import * as cdk from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { type RegionConfig, taskRoleName } from './config'
import { DataStack } from './stacks/data-stack'
import { EdgeStack } from './stacks/edge-stack'
import { MessagingStack } from './stacks/messaging-stack'
import { NetworkStack } from './stacks/network-stack'
import { ServiceStack } from './stacks/service-stack'

/** One full Closeline deployment in one Region (ADR 0001): every stack, built from one config. */
export class RegionStage extends cdk.Stage {
  readonly network: NetworkStack
  readonly data: DataStack
  readonly messaging?: MessagingStack
  readonly edge: EdgeStack
  readonly services: Record<string, ServiceStack> = {}

  constructor(scope: Construct, id: string, config: RegionConfig) {
    super(scope, id, { env: { account: config.account, region: config.region } })
    const tags = { environment: config.environment, project: 'closeline' }
    for (const [key, value] of Object.entries(tags)) {
      cdk.Tags.of(this).add(key, value)
    }

    // Outside dev a stack cannot be deleted by accident; dev is torn down freely.
    const terminationProtection = config.environment !== 'dev'
    this.network = new NetworkStack(this, 'network', {
      natGateways: config.natGateways,
      terminationProtection,
    })
    this.data = new DataStack(this, 'data', {
      vpc: this.network.vpc,
      environment: config.environment,
      multiAz: config.multiAz,
      terminationProtection,
      crmTokenRoleNames: config.services
        .filter((spec) => spec.kmsKey)
        .map((spec) => taskRoleName(config.environment, config.region, spec.name)),
    })
    // CloudFormation rejects an empty template, so no queues means no messaging stack.
    if (config.queues.length > 0) {
      this.messaging = new MessagingStack(this, 'messaging', {
        environment: config.environment,
        queues: config.queues,
        terminationProtection,
      })
    }
    this.edge = new EdgeStack(this, 'edge', {
      vpc: this.network.vpc,
      certificateArn: config.certificateArn,
      deletionProtection: terminationProtection,
      terminationProtection,
    })
    for (const spec of config.services) {
      this.services[spec.name] = new ServiceStack(this, `service-${spec.name}`, {
        environment: config.environment,
        terminationProtection,
        spec,
        network: this.network,
        listener: this.edge.listener,
        queues: this.messaging?.queues ?? {},
        bucket: this.data.bucket,
        crmTokenKey: this.data.crmTokenKey,
        databaseSecurityGroup: this.data.databaseSecurityGroup,
        database: {
          address: this.data.database.dbInstanceEndpointAddress,
          port: this.data.database.dbInstanceEndpointPort,
        },
      })
    }
  }
}
