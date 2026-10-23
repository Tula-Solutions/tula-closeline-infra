import * as cdk from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { QueueSpec } from '../config'
import { QueueWithDlq } from '../constructs/queue-with-dlq'

/** Properties of the messaging stack. */
export interface MessagingStackProps extends cdk.StackProps {
  queues: QueueSpec[]
}

/** The Region's queues, each with a dead-letter queue and an alarm on it. */
export class MessagingStack extends cdk.Stack {
  /** The queues by name, for services that take them as typed props. */
  readonly queues: Record<string, QueueWithDlq> = {}

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props)
    for (const spec of props.queues) {
      this.queues[spec.name] = new QueueWithDlq(this, `Queue-${spec.name}`, {
        queueName: spec.name,
        visibilityTimeout: cdk.Duration.seconds(spec.visibilityTimeoutSeconds),
      })
    }
  }
}
