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
    template.resourceCountIs('AWS::SQS::Queue', 2)
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

  test('core is granted SQS actions on the jobs queue only', () => {
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
      // Exactly one reference, to the jobs queue's ARN export (never its DLQ).
      expect(resource).toMatch(
        /^\{"Fn::ImportValue":"dev-messaging:[^"]*QueuecorejobsQueue[^"]*Arn[^"]*"\}$/
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
