import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import type { Construct } from 'constructs'

/** Properties of the edge stack. */
export interface EdgeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc
  certificateArn?: string
}

/**
 * The internet-facing load balancer. Services add their own path rules to `listener`; anything
 * unmatched gets a 404. With a certificate the listener is HTTPS and port 80 redirects to it.
 */
export class EdgeStack extends cdk.Stack {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer
  readonly listener: elbv2.ApplicationListener

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props)
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    })
    const notFound = elbv2.ListenerAction.fixedResponse(404, {
      contentType: 'text/plain',
      messageBody: 'not found',
    })
    if (props.certificateArn) {
      this.listener = this.loadBalancer.addListener('Https', {
        port: 443,
        certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
        defaultAction: notFound,
      })
      this.loadBalancer.addRedirect({
        sourcePort: 80,
        targetPort: 443,
        sourceProtocol: elbv2.ApplicationProtocol.HTTP,
        targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      })
    } else {
      this.listener = this.loadBalancer.addListener('Http', { port: 80, defaultAction: notFound })
    }
  }
}
