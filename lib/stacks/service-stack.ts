import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import type * as kms from 'aws-cdk-lib/aws-kms'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type * as sqs from 'aws-cdk-lib/aws-sqs'
import type { Construct } from 'constructs'
import { type RegionConfig, type ServiceSpec, secretName, taskRoleName } from '../config'
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
  /** The data stack's bucket, for a service that declares `storage`. */
  bucket: s3.IBucket
  /** The data stack's CRM token key, for a service that declares `kmsKey`. */
  crmTokenKey: kms.IKey
  /** The data stack's database security group; this service's group is admitted on 5432. */
  databaseSecurityGroup: ec2.ISecurityGroup
  /** The data stack's Postgres endpoint, published as an output for the owner's DATABASE_URL. */
  database: { address: string; port: string }
}

/**
 * One service: its ECS service, task role, queue grants, secrets and route. The image is a
 * reference to an existing ECR repository; secrets are referenced by the
 * `closeline/<environment>/<service>/<NAME>` convention, never created here. The bucket and
 * database endpoint arrive as typed props, not by name lookup.
 */
export class ServiceStack extends cdk.Stack {
  readonly service: CloselineService

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props)
    const { spec } = props
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', spec.repositoryName)
    this.service = new CloselineService(this, 'Service', {
      serviceName: spec.name,
      taskRoleName: taskRoleName(props.environment, this.region, spec.name),
      stage: props.environment,
      vpc: props.network.vpc,
      cluster: props.network.cluster,
      image: ecs.ContainerImage.fromEcrRepository(repository, spec.imageTag),
      port: spec.port,
      cpu: spec.cpu,
      memoryMiB: spec.memoryMiB,
      desiredCount: spec.desiredCount,
      ...(spec.autoscaling ? { autoscaling: spec.autoscaling } : {}),
      queues: spec.queues.map((q) => {
        const found = props.queues[q.queue]
        if (!found) {
          throw new Error(`service ${spec.name} uses unknown queue ${q.queue}`)
        }
        return { queue: found.queue, envName: q.envName, access: q.access }
      }),
      secrets: spec.secrets.map((envName) => ({
        envName,
        secret: secretsmanager.Secret.fromSecretNameV2(
          this,
          `Secret-${envName}`,
          secretName(props.environment, spec.name, envName)
        ),
      })),
      environment: spec.environment,
      ...(spec.storage
        ? {
            storage: {
              bucket: props.bucket,
              envName: spec.storage.envName,
              ...(spec.storage.keyPrefix === undefined
                ? {}
                : { keyPrefix: spec.storage.keyPrefix }),
            },
          }
        : {}),
      ...(spec.kmsKey ? { kmsKey: { key: props.crmTokenKey, envName: spec.kmsKey.envName } } : {}),
      route: {
        listener: props.listener,
        pathPatterns: spec.pathPatterns,
        healthCheckPath: spec.healthCheckPath,
        priority: spec.priority,
      },
    })

    // The rule lives in this stack (data must not depend on the services), naming the data
    // stack's group as the target.
    this.service.service.connections.allowTo(
      props.databaseSecurityGroup,
      ec2.Port.tcp(5432),
      `Postgres for ${spec.name}`
    )

    // Core reads DATABASE_URL only, a secret an owner creates with credentials. The host and port
    // are here so the owner can write it.
    new cdk.CfnOutput(this, 'DatabaseHost', { value: props.database.address })
    new cdk.CfnOutput(this, 'DatabasePort', { value: props.database.port })
  }
}
