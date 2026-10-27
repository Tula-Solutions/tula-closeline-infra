import { describe, expect, test } from 'bun:test'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { stages } from '../config/stages'
import { parseRegionConfig } from './config'
import { RegionStage } from './region-stage'

const dev = new RegionStage(
  new App(),
  'dev',
  parseRegionConfig({ ...stages.dev, account: '000000000000' })
)

function core(): Template {
  const stack = dev.services.core
  if (!stack) {
    throw new Error('the dev stage has no core service')
  }
  return Template.fromStack(stack)
}

describe('the dev stage: core-jobs queue', () => {
  test('the messaging stack has the queue, its DLQ at 5 receives, 180 s visibility and the alarm', () => {
    if (!dev.messaging) {
      throw new Error('the dev stage has no messaging stack')
    }
    const template = Template.fromStack(dev.messaging)
    template.resourceCountIs('AWS::SQS::Queue', 4)
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'core-jobs',
      VisibilityTimeout: 180,
      RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
    })
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'core-jobs-dlq' })
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'core-jobs-dlq-not-empty',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
    })
  })

  test('core receives the queue URL as JOBS_QUEUE_URL', () => {
    core().hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'ENVIRONMENT', Value: 'dev' }),
            Match.objectLike({ Name: 'JOBS_QUEUE_URL' }),
          ]),
        },
      ],
    })
  })

  test('core is granted SQS actions on its two queues only, never a DLQ', () => {
    const sqsStatements: { Action: string[]; Resource: unknown }[] = []
    for (const policy of Object.values(core().findResources('AWS::IAM::Policy'))) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        const actions = [s.Action].flat() as string[]
        if (actions.some((a) => a.startsWith('sqs:'))) {
          sqsStatements.push({ Action: actions, Resource: s.Resource })
        }
      }
    }
    expect(sqsStatements.length).toBeGreaterThan(0)
    const actions = sqsStatements.flatMap((s) => s.Action)
    expect(actions).toContain('sqs:SendMessage')
    expect(actions).toContain('sqs:ReceiveMessage')
    expect(actions).toContain('sqs:ChangeMessageVisibility')
    expect(actions).toContain('sqs:DeleteMessage')
    for (const s of sqsStatements) {
      const resource = JSON.stringify(s.Resource)
      expect(resource).not.toContain('"*"')
      // Exactly one reference, to the ARN export of the jobs or events queue (never a DLQ).
      expect(resource).toMatch(
        /^\{"Fn::ImportValue":"dev-messaging:[^"]*Queuecore(jobs|events)Queue[^"]*Arn[^"]*"\}$/
      )
    }
  })

  test('core is routed at /v1/* with the /healthz health check, not /internal', () => {
    core().hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/*'] } }],
    })
    core().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/healthz',
    })
  })
})

/** The environment and secrets of the core container in the dev stage. */
function coreContainer(): {
  Environment: { Name: string; Value?: unknown }[]
  Secrets: { Name: string; ValueFrom: unknown }[]
} {
  const task = Object.values(core().findResources('AWS::ECS::TaskDefinition'))[0]
  return task?.Properties.ContainerDefinitions[0]
}

const SECRETS = ['DATABASE_URL', 'INTERNAL_API_TOKENS', 'DEMO_RATE_KEY', 'CONSENT_HASH_KEY']

describe('the dev stage: core boot configuration', () => {
  test.each([
    ['ENVIRONMENT', 'dev'],
    ['REGION', 'us'],
    ['AWS_REGION', 'us-east-1'],
    ['AUTH_AUDIENCE', 'closeline'],
    ['TRUSTED_PROXY_HOPS', '1'],
  ])('core gets %s as a plain value', (name, value) => {
    expect(coreContainer().Environment).toContainEqual({ Name: name, Value: value })
  })

  test.each(['AUTH_JWKS_URL', 'AUTH_ISSUER', 'PORTAL_BASE_URL', 'DEMO_NOTICE_TO'])(
    'core gets %s as a non-empty plain value',
    (name) => {
      const found = coreContainer().Environment.find((e) => e.Name === name)
      expect(typeof found?.Value).toBe('string')
      expect(found?.Value).not.toBe('')
    }
  )

  test('core gets the bucket name and both queue URLs from the stack, not from a literal', () => {
    for (const name of ['STORAGE_BUCKET', 'QUEUE_URL', 'JOBS_QUEUE_URL', 'CRM_TOKEN_KMS_KEY_ARN']) {
      const found = coreContainer().Environment.find((e) => e.Name === name)
      expect(typeof found?.Value).toBe('object')
    }
  })

  test.each(SECRETS)('%s is an ECS secret that names closeline/dev/core/%s', (name) => {
    const found = coreContainer().Secrets.find((s) => s.Name === name)
    expect(JSON.stringify(found?.ValueFrom)).toContain(`closeline/dev/core/${name}`)
  })

  test('no secret appears as a plain environment value, by name or by secret name', () => {
    const environment = JSON.stringify(coreContainer().Environment)
    for (const name of SECRETS) {
      expect(coreContainer().Environment.map((e) => e.Name)).not.toContain(name)
      expect(environment).not.toContain(`closeline/dev/core/${name}`)
    }
    expect(
      coreContainer()
        .Secrets.map((s) => s.Name)
        .sort()
    ).toEqual([...SECRETS].sort())
  })

  test('the database endpoint is passed as a typed prop and published as a stack output', () => {
    const outputs = core().toJSON().Outputs
    expect(JSON.stringify(outputs.DatabaseHost.Value)).toMatch(
      /dev-data:.*Postgres.*EndpointAddress/
    )
  })

  test('core has an event queue with a DLQ, and is granted send and consume on it', () => {
    if (!dev.messaging) {
      throw new Error('the dev stage has no messaging stack')
    }
    Template.fromStack(dev.messaging).hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'core-events',
      RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
    })
    const resources: string[] = []
    for (const policy of Object.values(core().findResources('AWS::IAM::Policy'))) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        if ([s.Action].flat().includes('sqs:SendMessage')) {
          resources.push(JSON.stringify(s.Resource))
        }
      }
    }
    expect(resources.some((r) => r.includes('QueuecoreeventsQueue'))).toBe(true)
    expect(resources.some((r) => r.includes('QueuecorejobsQueue'))).toBe(true)
  })

  test('core may get, put and delete under orgs/ and list the bucket (for a 404 on a missing key)', () => {
    const statements: { Action: string[]; Resource: unknown; Condition?: unknown }[] = []
    for (const policy of Object.values(core().findResources('AWS::IAM::Policy'))) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        const actions = [s.Action].flat() as string[]
        if (actions.some((a) => a.startsWith('s3:'))) {
          statements.push({ Action: actions, Resource: s.Resource, Condition: s.Condition })
        }
      }
    }
    const objects = statements.find((s) => s.Action.includes('s3:GetObject'))
    expect(objects?.Action.sort()).toEqual(['s3:DeleteObject', 's3:GetObject', 's3:PutObject'])
    expect(JSON.stringify(objects?.Resource)).toContain('/orgs/*')
    const list = statements.find((s) => s.Action.includes('s3:ListBucket'))
    expect(list?.Action).toEqual(['s3:ListBucket'])
    // No s3:prefix condition: S3 sends none for a head of a missing key, so it would not match.
    expect(list?.Condition).toBeUndefined()
    expect(statements).toHaveLength(2)
  })

  test('core gets the CRM token key ARN, and only core may use that key', () => {
    const arn = coreContainer().Environment.find((e) => e.Name === 'CRM_TOKEN_KMS_KEY_ARN')
    expect(JSON.stringify(arn?.Value)).toContain('Arn')
    const statements: { Action: string[]; Resource: unknown; Condition?: unknown }[] = []
    for (const policy of Object.values(core().findResources('AWS::IAM::Policy'))) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        const actions = [s.Action].flat() as string[]
        if (actions.some((a) => a.startsWith('kms:'))) {
          statements.push({ Action: actions, Resource: s.Resource, Condition: s.Condition })
        }
      }
    }
    expect(statements).toHaveLength(1)
    expect(statements[0]?.Action.sort()).toEqual([
      'kms:Decrypt',
      'kms:Encrypt',
      'kms:GenerateDataKey',
    ])
    expect(statements[0]?.Condition).toEqual({
      StringEquals: { 'kms:EncryptionContext:closeline:service': 'core' },
    })
    expect(JSON.stringify(statements[0]?.Resource)).toContain('Arn')
  })

  test('no other stack in the stage grants kms actions to a role', () => {
    for (const stack of [
      dev.network,
      dev.data,
      dev.edge,
      ...(dev.messaging ? [dev.messaging] : []),
    ]) {
      for (const policy of Object.values(
        Template.fromStack(stack).findResources('AWS::IAM::Policy')
      )) {
        for (const s of policy.Properties.PolicyDocument.Statement) {
          expect([s.Action].flat().some((a: string) => a.startsWith('kms:'))).toBe(false)
        }
      }
    }
  })
})

describe('the dev stage: database access', () => {
  test('the database security group has no CIDR rule; only the core service group may connect', () => {
    const data = Template.fromStack(dev.data)
    for (const sg of Object.values(data.findResources('AWS::EC2::SecurityGroup'))) {
      expect(JSON.stringify(sg.Properties.SecurityGroupIngress ?? [])).not.toContain('CidrIp')
    }
    const rules = Object.values(core().findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (r) => r.Properties.FromPort === 5432
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]?.Properties).toMatchObject({
      FromPort: 5432,
      ToPort: 5432,
      IpProtocol: 'tcp',
      GroupId: { 'Fn::ImportValue': expect.stringMatching(/^dev-data:.*DatabaseSg.*GroupId/) },
      SourceSecurityGroupId: {
        'Fn::GetAtt': [expect.stringContaining('SecurityGroup'), 'GroupId'],
      },
    })
  })
})

describe('the dev stage: CRM key policy', () => {
  test('core has the fixed role name the key policy names, and the key policy names it', () => {
    core().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'closeline-dev-us-east-1-core-task',
    })
    const key = Object.values(Template.fromStack(dev.data).findResources('AWS::KMS::Key'))[0]
    expect(JSON.stringify(key?.Properties.KeyPolicy)).toContain(
      ':role/closeline-dev-us-east-1-core-task'
    )
  })
})
