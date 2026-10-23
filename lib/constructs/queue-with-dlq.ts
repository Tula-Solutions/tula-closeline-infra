import { Duration } from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'

/** Receives before a message moves to the dead-letter queue. */
export const MAX_RECEIVE_COUNT = 5

/** Settings for a queue with its dead-letter queue. */
export interface QueueWithDlqProps {
  /** Queue name; the DLQ is `<name>-dlq`. */
  queueName: string
  /** Must exceed the longest time a consumer needs for one message. Default 30 seconds. */
  visibilityTimeout?: Duration
}

/** A queue whose failures land in a dead-letter queue that raises a CloudWatch alarm. */
export class QueueWithDlq extends Construct {
  readonly queue: sqs.Queue
  readonly deadLetterQueue: sqs.Queue
  readonly alarm: cloudwatch.Alarm

  constructor(scope: Construct, id: string, props: QueueWithDlqProps) {
    super(scope, id)
    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      queueName: `${props.queueName}-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    })
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: props.queueName,
      visibilityTimeout: props.visibilityTimeout ?? Duration.seconds(30),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
    })
    this.alarm = new cloudwatch.Alarm(this, 'DlqDepth', {
      alarmName: `${props.queueName}-dlq-not-empty`,
      alarmDescription: `Messages are in ${props.queueName}-dlq: a consumer failed ${MAX_RECEIVE_COUNT} times`,
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
  }
}
