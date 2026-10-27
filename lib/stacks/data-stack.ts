import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'

/** Properties of the data stack. */
export interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc
  /** The stage, used in the alias of the stage's keys. */
  environment: string
  /** Names of the task roles that may use the CRM token key (see `taskRoleName`). */
  crmTokenRoleNames: string[]
}

/**
 * The Region's Postgres (ADR 0007), object storage and the key that seals core's CRM tokens. All
 * are retained when the stack is deleted or the resource is replaced, so a stack change never
 * destroys data.
 */
export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance
  readonly databaseSecurityGroup: ec2.SecurityGroup
  readonly bucket: s3.Bucket
  /** Seals core's CRM tokens (envelope encryption); only the named task roles may use it. */
  readonly crmTokenKey: kms.Key

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props)

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: props.vpc,
      // No rule here: each service stack admits its own security group (see service-stack.ts).
      description: 'Closeline Postgres: reachable from the service security groups only',
      allowAllOutbound: false,
    })
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
    // sealed token unreadable. The key policy is explicit: the account may administer the key
    // (so it is never orphaned and CloudFormation can still update it) but not use it, and the
    // account root is delegated use only when the caller is one of the named task roles. IAM
    // `kms:*` on another principal therefore grants nothing. Roles are named by ARN, not by
    // reference, because the service stack depends on this one.
    this.crmTokenKey = new kms.Key(this, 'CrmTokenKey', {
      alias: `alias/closeline/${props.environment}/core/crm-tokens`,
      description: `Seals core's CRM tokens (${props.environment})`,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'KeyAdministration',
            principals: [new iam.AccountRootPrincipal()],
            actions: KEY_ADMIN_ACTIONS,
            resources: ['*'],
          }),
          ...(props.crmTokenRoleNames.length > 0
            ? [
                new iam.PolicyStatement({
                  sid: 'ServiceUse',
                  principals: [new iam.AccountRootPrincipal()],
                  actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
                  resources: ['*'],
                  conditions: {
                    ArnEquals: {
                      'aws:PrincipalArn': props.crmTokenRoleNames.map(
                        (name) => `arn:${this.partition}:iam::${this.account}:role/${name}`
                      ),
                    },
                  },
                }),
              ]
            : []),
        ],
      }),
    })
  }
}

/**
 * Management without use: no Create* wildcard, because kms:CreateGrant would let an admin hand out
 * use. (PutKeyPolicy can still rewrite the policy, which is what an administrator is.)
 */
const KEY_ADMIN_ACTIONS = [
  'kms:CreateAlias',
  'kms:DeleteAlias',
  'kms:UpdateAlias',
  'kms:DescribeKey',
  'kms:EnableKey',
  'kms:DisableKey',
  'kms:EnableKeyRotation',
  'kms:DisableKeyRotation',
  'kms:GetKeyRotationStatus',
  'kms:GetKeyPolicy',
  'kms:PutKeyPolicy',
  'kms:UpdateKeyDescription',
  'kms:ListResourceTags',
  'kms:ListGrants',
  'kms:RevokeGrant',
  'kms:TagResource',
  'kms:UntagResource',
  'kms:ScheduleKeyDeletion',
  'kms:CancelKeyDeletion',
]
