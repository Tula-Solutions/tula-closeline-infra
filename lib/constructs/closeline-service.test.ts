import { describe, expect, test } from 'bun:test'
import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import {
  CloselineService,
  type CloselineServiceProps,
  type ServiceQueue,
  type ServiceSecret,
} from './closeline-service'

interface Options {
  queues?: (queue: sqs.IQueue) => ServiceQueue[]
  secrets?: (secret: secretsmanager.ISecret) => ServiceSecret[]
  environment?: Record<string, string>
  storage?: boolean
}

function synth(options: Options = {}): Template {
  const stack = new Stack(new App(), 'test', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  const vpc = new ec2.Vpc(stack, 'Vpc')
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc })
  const jobs = new sqs.Queue(stack, 'Jobs')
  const other = new sqs.Queue(stack, 'Other')
  const secret = new secretsmanager.Secret(stack, 'Secret')
  const props: CloselineServiceProps = {
    serviceName: 'core',
    stage: 'dev',
    vpc,
    cluster,
    image: ecs.ContainerImage.fromRegistry('placeholder/core:latest'),
    port: 3000,
    cpu: 256,
    memoryMiB: 512,
    desiredCount: 1,
    queues: options.queues?.(jobs) ?? [],
    secrets: options.secrets?.(secret) ?? [],
    environment: options.environment ?? {},
    ...(options.storage
      ? {
          storage: {
            bucket: new s3.Bucket(stack, 'Objects'),
            envName: 'STORAGE_BUCKET',
            keyPrefix: 'orgs/',
          },
        }
      : {}),
  }
  expect(other).toBeDefined()
  new CloselineService(stack, 'Core', props)
  return Template.fromStack(stack)
}

function taskRolePolicyStatements(template: Template): { Action: string[]; Resource: unknown }[] {
  const roles = template.findResources('AWS::IAM::Role', {
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [{ Principal: { Service: 'ecs-tasks.amazonaws.com' } }],
      },
    },
  })
  const taskRoleIds = Object.entries(roles)
    .filter(([id]) => id.includes('TaskRole'))
    .map(([id]) => id)
  const statements: { Action: string[]; Resource: unknown }[] = []
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const attached = (policy.Properties.Roles as { Ref: string }[]).map((r) => r.Ref)
    if (attached.some((id) => taskRoleIds.includes(id))) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        statements.push({ ...s, Action: [s.Action].flat() })
      }
    }
  }
  return statements
}

describe('CloselineService', () => {
  test('a task role with no grants has no policy at all', () => {
    expect(taskRolePolicyStatements(synth())).toEqual([])
  })

  test('send access grants SendMessage and nothing on other queues or services', () => {
    const template = synth({ queues: (q) => [{ queue: q, envName: 'JOBS_URL', access: 'send' }] })
    const statements = taskRolePolicyStatements(template)
    const actions = statements.flatMap((s) => s.Action).sort()
    expect(actions).toEqual(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage'])
    for (const s of statements) {
      expect(JSON.stringify(s.Resource)).not.toContain('"*"')
      expect(JSON.stringify(s.Resource)).toContain('Jobs')
      expect(JSON.stringify(s.Resource)).not.toContain('Other')
    }
  })

  test('consume access cannot send; send access cannot receive or delete', () => {
    const consume = taskRolePolicyStatements(
      synth({ queues: (q) => [{ queue: q, envName: 'JOBS_URL', access: 'consume' }] })
    ).flatMap((s) => s.Action)
    expect(consume).toContain('sqs:ReceiveMessage')
    expect(consume).not.toContain('sqs:SendMessage')
    const send = taskRolePolicyStatements(
      synth({ queues: (q) => [{ queue: q, envName: 'JOBS_URL', access: 'send' }] })
    ).flatMap((s) => s.Action)
    expect(send).not.toContain('sqs:ReceiveMessage')
    expect(send).not.toContain('sqs:DeleteMessage')
  })

  test('the task role gets no secret, S3 or wildcard access from the secrets passed in', () => {
    const template = synth({
      secrets: (s) => [{ envName: 'DATABASE_PASSWORD', secret: s, field: 'password' }],
    })
    const actions = taskRolePolicyStatements(template).flatMap((s) => s.Action)
    expect(actions).toEqual([])
  })

  test('secrets reach the container as ECS secrets, never as plain environment values', () => {
    const template = synth({
      secrets: (s) => [{ envName: 'DATABASE_PASSWORD', secret: s, field: 'password' }],
    })
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          Secrets: [{ Name: 'DATABASE_PASSWORD', ValueFrom: Match.anyValue() }],
          Environment: Match.not(
            Match.arrayWith([Match.objectLike({ Name: 'DATABASE_PASSWORD' })])
          ),
        },
      ],
    })
    const body = JSON.stringify(
      Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]?.Properties
        .ContainerDefinitions[0].Environment
    )
    expect(body).not.toContain('DATABASE_PASSWORD')
  })

  test('the execution role, not the task role, reads the secret', () => {
    const template = synth({
      secrets: (s) => [{ envName: 'DATABASE_PASSWORD', secret: s }],
    })
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          }),
        ]),
      },
      Roles: [{ Ref: Match.stringLikeRegexp('ExecutionRole') }],
    })
  })

  test('logs go to a log group that expires after 30 days', () => {
    synth().hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 })
  })

  test('ENVIRONMENT is set from the stage, not NODE_ENV', () => {
    synth().hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [{ Environment: [{ Name: 'ENVIRONMENT', Value: 'dev' }] }],
    })
  })

  test('the queue URL is passed as a plain value under the chosen name', () => {
    synth({
      queues: (q) => [{ queue: q, envName: 'JOBS_QUEUE_URL', access: 'both' }],
    }).hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        { Environment: Match.arrayWith([Match.objectLike({ Name: 'JOBS_QUEUE_URL' })]) },
      ],
    })
  })

  test('plain settings reach the container as environment values', () => {
    synth({ environment: { REGION: 'us', TRUSTED_PROXY_HOPS: '1' } }).hasResourceProperties(
      'AWS::ECS::TaskDefinition',
      {
        ContainerDefinitions: [
          {
            Environment: Match.arrayWith([
              { Name: 'REGION', Value: 'us' },
              { Name: 'TRUSTED_PROXY_HOPS', Value: '1' },
            ]),
          },
        ],
      }
    )
  })

  test('a plain setting that collides with a secret, queue or ENVIRONMENT is refused', () => {
    expect(() =>
      synth({
        environment: { DB: 'x' },
        secrets: (s) => [{ envName: 'DB', secret: s }],
      })
    ).toThrow('unique')
    expect(() => synth({ environment: { ENVIRONMENT: 'prod' } })).toThrow('unique')
  })

  test('storage grants object get, put and delete on the key prefix only, plus a prefixed list', () => {
    const template = synth({ storage: true })
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        { Environment: Match.arrayWith([Match.objectLike({ Name: 'STORAGE_BUCKET' })]) },
      ],
    })
    const statements = taskRolePolicyStatements(template)
    const objects = statements.find((s) => s.Action.includes('s3:GetObject'))
    expect(objects?.Action.sort()).toEqual(['s3:DeleteObject', 's3:GetObject', 's3:PutObject'])
    expect(JSON.stringify(objects?.Resource)).toContain('/orgs/*')
    expect(JSON.stringify(objects?.Resource)).not.toContain('"/*"')
    const list = statements.find((s) => s.Action.includes('s3:ListBucket')) as
      | { Action: string[]; Resource: unknown; Condition?: unknown }
      | undefined
    expect(list?.Action).toEqual(['s3:ListBucket'])
    expect(list?.Condition).toEqual({ StringLike: { 's3:prefix': ['orgs/*'] } })
    expect(JSON.stringify(list?.Resource)).not.toContain('/*')
    expect(statements.flatMap((s) => s.Action).sort()).toEqual([
      's3:DeleteObject',
      's3:GetObject',
      's3:ListBucket',
      's3:PutObject',
    ])
  })

  test('a duplicate or reserved environment variable name is refused', () => {
    expect(() =>
      synth({ queues: (q) => [{ queue: q, envName: 'ENVIRONMENT', access: 'send' }] })
    ).toThrow('unique')
  })

  test('the service runs in private subnets and rolls back a failed deploy', () => {
    const template = synth()
    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } },
    })
  })
})
