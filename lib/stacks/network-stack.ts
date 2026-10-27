import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import type { Construct } from 'constructs'

/** Properties of the network stack. */
export interface NetworkStackProps extends cdk.StackProps {
  natGateways: number
}

/** The VPC (public, private and isolated subnets) and the ECS cluster the services run in. */
export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc
  readonly cluster: ecs.Cluster

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props)
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })
    // Rotating the database secret runs a Lambda in the isolated data subnets, which have no
    // route out; it reaches Secrets Manager through this endpoint instead.
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    })
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    })
  }
}
