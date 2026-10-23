import * as cdk from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type * as sqs from 'aws-cdk-lib/aws-sqs'
import type { Construct } from 'constructs'
import type { RegionConfig, ServiceSpec } from '../config'
import { CloselineService } from '../constructs/closeline-service'
import type { NetworkStack } from './network-stack'

/** Properties of one service's stack. */
export interface ServiceStackProps extends cdk.StackProps {
  environment: RegionConfig['environment']
  spec: ServiceSpec
  network: NetworkStack
  listener: elbv2.IApplicationListener
  /** Queues by name, from the messaging stack. */
  queues: Record<string, { queue: sqs.IQueue }>
}

/**
 * One service: its ECS service, task role, queue grants, secrets and route. The image is a
 * reference to an existing ECR repository; secrets are looked up by name, never created here.
 */
export class ServiceStack extends cdk.Stack {
  readonly service: CloselineService

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props)
    const { spec } = props
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', spec.repositoryName)
    this.service = new CloselineService(this, 'Service', {
      serviceName: spec.name,
      environment: props.environment,
      vpc: props.network.vpc,
      cluster: props.network.cluster,
      image: ecs.ContainerImage.fromEcrRepository(repository, spec.imageTag),
      port: spec.port,
      cpu: spec.cpu,
      memoryMiB: spec.memoryMiB,
      desiredCount: spec.desiredCount,
      queues: spec.queues.map((q) => {
        const found = props.queues[q.queue]
        if (!found) {
          throw new Error(`service ${spec.name} uses unknown queue ${q.queue}`)
        }
        return { queue: found.queue, envName: q.envName, access: q.access }
      }),
      secrets: spec.secrets.map((s) => ({
        envName: s.envName,
        field: s.field,
        secret: secretsmanager.Secret.fromSecretNameV2(this, `Secret-${s.envName}`, s.secretName),
      })),
      route: {
        listener: props.listener,
        pathPatterns: spec.pathPatterns,
        healthCheckPath: spec.healthCheckPath,
        priority: spec.priority,
      },
    })
  }
}
