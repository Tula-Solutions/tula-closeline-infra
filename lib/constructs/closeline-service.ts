import { Duration } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'
import type { environmentSchema } from '../config'

/** A queue a service uses, how, and the environment variable that carries its URL. */
export interface ServiceQueue {
  queue: sqs.IQueue
  /** Environment variable holding the queue URL. */
  envName: string
  /** `send` grants SendMessage only; `consume` grants receive and delete only. */
  access: 'send' | 'consume' | 'both'
}

/** A Secrets Manager secret exposed to the container as an ECS secret. */
export interface ServiceSecret {
  /** Environment variable the container reads. */
  envName: string
  secret: secretsmanager.ISecret
  /** JSON key inside the secret; the whole secret string when omitted. */
  field?: string
}

/** An object bucket a service reads and writes, and the variable that carries its name. */
export interface ServiceStorage {
  bucket: s3.IBucket
  /** Environment variable holding the bucket name. */
  envName: string
  /** Key prefix (ending in `/`) the grants are limited to; the whole bucket when omitted. */
  keyPrefix?: string
}

/** Where the ALB sends traffic for a service. */
export interface ServiceRoute {
  listener: elbv2.IApplicationListener
  pathPatterns: string[]
  healthCheckPath: string
  /** Listener rule priority, unique per listener. */
  priority: number
}

/** Properties of a Closeline service. */
export interface CloselineServiceProps {
  /** Service name, e.g. `core`. */
  serviceName: string
  /** The deployment environment, passed as `ENVIRONMENT`. */
  stage: (typeof environmentSchema)['_output']
  vpc: ec2.IVpc
  cluster: ecs.ICluster
  image: ecs.ContainerImage
  port: number
  cpu: number
  memoryMiB: number
  desiredCount: number
  queues: ServiceQueue[]
  secrets: ServiceSecret[]
  /** Non-secret settings, passed as plain environment values. */
  environment: Record<string, string>
  storage?: ServiceStorage
  route?: ServiceRoute
}

/** An ECS Fargate service whose task role holds exactly the grants named in its props. */
export class CloselineService extends Construct {
  readonly service: ecs.FargateService
  readonly taskRole: iam.Role

  constructor(scope: Construct, id: string, props: CloselineServiceProps) {
    super(scope, id)

    const envNames = [
      ...props.queues.map((q) => q.envName),
      ...props.secrets.map((s) => s.envName),
      ...Object.keys(props.environment),
      ...(props.storage ? [props.storage.envName] : []),
    ]
    if (new Set(envNames).size !== envNames.length || envNames.includes('ENVIRONMENT')) {
      throw new Error(`service ${props.serviceName}: environment variable names must be unique`)
    }

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Task role of the ${props.serviceName} service`,
    })
    for (const { queue, access } of props.queues) {
      if (access !== 'consume') {
        queue.grantSendMessages(this.taskRole)
      }
      if (access !== 'send') {
        queue.grantConsumeMessages(this.taskRole)
      }
    }

    if (props.storage) {
      const { bucket, keyPrefix = '' } = props.storage
      // Object-level only, under the key prefix: no bucket or ACL administration.
      this.taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [bucket.arnForObjects(`${keyPrefix}*`)],
        })
      )
      // Without ListBucket, S3 answers 403 instead of 404 for a missing key, so a head of an
      // absent object would throw. Listing is limited to the same prefix.
      this.taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [bucket.bucketArn],
          ...(keyPrefix === ''
            ? {}
            : { conditions: { StringLike: { 's3:prefix': [`${keyPrefix}*`] } } }),
        })
      )
    }

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryMiB,
      taskRole: this.taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    const environment: Record<string, string> = {
      ...props.environment,
      ENVIRONMENT: props.stage,
    }
    if (props.storage) {
      environment[props.storage.envName] = props.storage.bucket.bucketName
    }
    for (const { queue, envName } of props.queues) {
      environment[envName] = queue.queueUrl
    }
    const secrets: Record<string, ecs.Secret> = {}
    for (const { envName, secret, field } of props.secrets) {
      secrets[envName] = ecs.Secret.fromSecretsManager(secret, field)
    }

    taskDefinition.addContainer('App', {
      image: props.image,
      portMappings: [{ containerPort: props.port }],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: props.serviceName,
        logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH }),
      }),
    })

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    })

    if (props.route) {
      const targetGroup = new elbv2.ApplicationTargetGroup(this, 'Targets', {
        vpc: props.vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: props.port,
        targets: [this.service],
        deregistrationDelay: Duration.seconds(30),
        healthCheck: { path: props.route.healthCheckPath, interval: Duration.seconds(30) },
      })
      new elbv2.ApplicationListenerRule(this, 'Rule', {
        listener: props.route.listener,
        priority: props.route.priority,
        conditions: [elbv2.ListenerCondition.pathPatterns(props.route.pathPatterns)],
        action: elbv2.ListenerAction.forward([targetGroup]),
      })
    }
  }
}
