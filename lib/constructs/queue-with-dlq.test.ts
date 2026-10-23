import { describe, expect, test } from 'bun:test'
import { App, Duration, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { QueueWithDlq } from './queue-with-dlq'

function synth(visibilityTimeout?: Duration): Template {
  const stack = new Stack(new App(), 'test')
  new QueueWithDlq(stack, 'Jobs', { queueName: 'core-jobs', visibilityTimeout })
  return Template.fromStack(stack)
}

describe('QueueWithDlq', () => {
  test('the main queue redrives to the DLQ after 5 receives', () => {
    const template = synth()
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'core-jobs',
      RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
    })
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'core-jobs-dlq' })
  })

  test('the DLQ has no redrive policy of its own', () => {
    const template = synth()
    const dlq = Object.values(template.findResources('AWS::SQS::Queue')).find(
      (r) => r.Properties.QueueName === 'core-jobs-dlq'
    )
    expect(dlq?.Properties.RedrivePolicy).toBeUndefined()
  })

  test('an alarm fires when the DLQ holds a message, and quiet data is not a breach', () => {
    synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Dimensions: [{ Name: 'QueueName', Value: Match.anyValue() }],
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    })
  })

  test('the alarm watches the DLQ and not the main queue', () => {
    const template = synth()
    const dlqLogicalId = Object.entries(template.findResources('AWS::SQS::Queue')).find(
      ([, r]) => r.Properties.QueueName === 'core-jobs-dlq'
    )?.[0]
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [dlqLogicalId, 'QueueName'] } }],
    })
  })

  test('the visibility timeout is configurable and defaults to 30 seconds', () => {
    synth(Duration.seconds(90)).hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'core-jobs',
      VisibilityTimeout: 90,
    })
    synth().hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'core-jobs',
      VisibilityTimeout: 30,
    })
  })

  test('both queues are encrypted and refuse plain HTTP', () => {
    const template = synth()
    template.allResourcesProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true })
    template.resourceCountIs('AWS::SQS::QueuePolicy', 2)
  })
})
