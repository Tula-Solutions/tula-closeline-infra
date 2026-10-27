import { describe, expect, test } from 'bun:test'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { stages } from '../config/stages'
import { buildApp } from './app'
import { parseRegionConfig } from './config'
import { RegionStage } from './region-stage'

const account = '123456789012'

function withServices(): RegionStage {
  const config = parseRegionConfig({
    ...stages.dev,
    account,
    certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
    queues: [{ name: 'core-jobs', visibilityTimeoutSeconds: 60 }],
    services: [
      {
        name: 'core',
        repositoryName: 'closeline/core',
        imageTag: 'placeholder',
        pathPatterns: ['/core/*'],
        priority: 10,
        queues: [{ queue: 'core-jobs', envName: 'JOBS_QUEUE_URL', access: 'both' }],
        secrets: ['DATABASE_URL'],
      },
    ],
  })
  return new RegionStage(new App(), 'dev', config)
}

describe('every stage in config/stages.ts', () => {
  for (const name of Object.keys(stages)) {
    test(`${name} synthesises without AWS credentials`, () => {
      const assembly = buildApp('000000000000').synth()
      const stage = assembly.getNestedAssembly(`assembly-${name}`)
      const definition = stages[name]
      const expected = [`${name}-data`, `${name}-edge`, `${name}-network`]
      if (definition?.queues?.length) {
        expected.push(`${name}-messaging`)
      }
      for (const service of definition?.services ?? []) {
        expected.push(`${name}-service-${service.name}`)
      }
      expect(stage.stacks.map((s) => s.stackName).sort()).toEqual(expected.sort())
    })
  }

  test('the account is never taken from source', () => {
    const saved = process.env.CDK_DEFAULT_ACCOUNT
    delete process.env.CDK_DEFAULT_ACCOUNT
    try {
      expect(() => buildApp()).toThrow('Set the AWS account')
    } finally {
      if (saved !== undefined) {
        process.env.CDK_DEFAULT_ACCOUNT = saved
      }
    }
  })
})

describe('a Region with a queue and a service', () => {
  const stage = withServices()

  test('the service stack synthesises and the queue is granted only to that service', () => {
    const template = Template.fromStack(stage.services.core as never)
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          Secrets: [{ Name: 'DATABASE_URL', ValueFrom: Match.anyValue() }],
          Environment: Match.arrayWith([Match.objectLike({ Name: 'ENVIRONMENT', Value: 'dev' })]),
        },
      ],
    })
  })

  test('the edge routes the path pattern to the service and 404s the rest', () => {
    Template.fromStack(stage.services.core as never).hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::ListenerRule',
      {
        Priority: 10,
        Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/core/*'] } }],
      }
    )
    const edge = Template.fromStack(stage.edge)
    edge.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
    })
    edge.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [{ Type: 'redirect' }],
    })
  })

  test('the messaging stack alarms on the DLQ of every queue', () => {
    const template = Template.fromStack(stage.messaging as never)
    template.resourceCountIs('AWS::SQS::Queue', 2)
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1)
  })
})

describe('stack termination protection', () => {
  const protectedStatus = (environment: 'dev' | 'staging'): boolean[] => {
    const stage = new RegionStage(
      new App(),
      environment,
      parseRegionConfig({
        ...stages.dev,
        environment,
        account,
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      })
    )
    return [
      stage.network,
      stage.data,
      stage.edge,
      ...(stage.messaging ? [stage.messaging] : []),
      ...Object.values(stage.services),
    ].map((stack) => stack.terminationProtection)
  }

  test('every stack of a staging stage is protected', () => {
    const status = protectedStatus('staging')
    expect(status.length).toBeGreaterThanOrEqual(5)
    expect(status.every(Boolean)).toBe(true)
  })

  test('no stack of the dev stage is, so it can be torn down', () => {
    expect(protectedStatus('dev').some(Boolean)).toBe(false)
  })
})
