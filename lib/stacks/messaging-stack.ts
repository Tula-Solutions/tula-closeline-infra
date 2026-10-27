import * as cdk from 'aws-cdk-lib'
import * as sns from 'aws-cdk-lib/aws-sns'
import type { Construct } from 'constructs'
import type { QueueSpec } from '../config'
import { QueueWithDlq } from '../constructs/queue-with-dlq'

/** Properties of the messaging stack. */
export interface MessagingStackProps extends cdk.StackProps {
  queues: QueueSpec[]
}

/**
 * The Region's queues, each with a dead-letter queue and an alarm on it, and the topic those
 * alarms notify. The topic has no subscribers here: an owner subscribes a person or a pager.
 */
export class MessagingStack extends cdk.Stack {
  /** The queues by name, for services that take them as typed props. */
  readonly queues: Record<string, QueueWithDlq> = {}
  /** Where alarms go; subscribe an endpoint to it to be told. */
  readonly alarmTopic: sns.Topic

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props)
    this.alarmTopic = new sns.Topic(this, 'Alarms', {
      displayName: 'Closeline alarms',
      enforceSSL: true,
    })
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn })
    for (const spec of props.queues) {
      this.queues[spec.name] = new QueueWithDlq(this, `Queue-${spec.name}`, {
        queueName: spec.name,
        visibilityTimeout: cdk.Duration.seconds(spec.visibilityTimeoutSeconds),
        alarmTopic: this.alarmTopic,
      })
    }
  }
}
