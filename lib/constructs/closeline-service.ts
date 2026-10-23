import { Duration } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
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
  environment: (typeof environmentSchema)['_output']
  vpc: ec2.IVpc
  cluster: ecs.ICluster
  image: ecs.ContainerImage
  port: number
  cpu: number
  memoryMiB: number
  desiredCount: number
  queues: ServiceQueue[]
  secrets: ServiceSecret[]
  route?: ServiceRoute
}

/** An ECS Fargate service whose task role holds exactly the grants named in its props. */
export class CloselineService extends Construct {
  readonly service: ecs.FargateService
  readonly taskRole: iam.Role

  constructor(scope: Construct, id: string, props: CloselineServiceProps) {
    super(scope, id)

    const envNames = [...props.queues.map((q) => q.envName), ...props.secrets.map((s) => s.envName)]
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

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryMiB,
      taskRole: this.taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    const environment: Record<string, string> = { ENVIRONMENT: props.environment }
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
