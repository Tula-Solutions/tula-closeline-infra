import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'

/** Properties of the data stack. */
export interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc
  /** The stage, used in the alias of the stage's keys. */
  environment: string
}

/**
 * The Region's Postgres (ADR 0007), object storage and the key that seals core's CRM tokens. All are retained when the
 * stack is deleted or the resource is replaced, so a stack change never destroys data.
 */
export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance
  readonly databaseSecurityGroup: ec2.SecurityGroup
  readonly bucket: s3.Bucket
  /** Seals core's CRM tokens (envelope encryption); only core's task role may use it. */
  readonly crmTokenKey: kms.Key

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props)

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: props.vpc,
      description:
        'Closeline Postgres: reachable from inside the VPC only (per-service rules to follow)',
      allowAllOutbound: false,
    })
    this.databaseSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Postgres from inside the VPC'
    )
    // The generated credentials must outlive the stack as long as the database does.
    const adminSecret = new rds.DatabaseSecret(this, 'AdminSecret', {
      username: 'closeline_admin',
    })
    adminSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN)
    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_9,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      allocatedStorage: 20,
      maxAllocatedStorage: 200,
      storageEncrypted: true,
      publiclyAccessible: false,
      credentials: rds.Credentials.fromSecret(adminSecret),
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    this.bucket = new s3.Bucket(this, 'Objects', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Symmetric, rotated every year, and kept if the stack goes: a deleted key would make every
    // sealed token unreadable. The default key policy delegates to IAM; the only grant is core's.
    this.crmTokenKey = new kms.Key(this, 'CrmTokenKey', {
      alias: `alias/closeline/${props.environment}/core/crm-tokens`,
      description: `Seals core's CRM tokens (${props.environment})`,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
  }
}
