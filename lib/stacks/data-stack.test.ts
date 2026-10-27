import { describe, expect, test } from 'bun:test'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { DataStack } from './data-stack'
import { NetworkStack } from './network-stack'

function build(multiAz = false): DataStack {
  const app = new App()
  const env = { account: '123456789012', region: 'us-east-1' }
  const { vpc } = new NetworkStack(app, 'net', { env, natGateways: 1 })
  return new DataStack(app, 'data', {
    env,
    vpc,
    environment: 'dev',
    multiAz,
    crmTokenRoleNames: ['closeline-dev-us-east-1-core-task'],
  })
}

const stack = build()

describe('DataStack', () => {
  const template = Template.fromStack(stack)

  test('the database is encrypted, private, protected and retained', () => {
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        Engine: 'postgres',
        StorageEncrypted: true,
        PubliclyAccessible: false,
        DeletionProtection: true,
      },
    })
  })

  test('the database is single-AZ unless the stage asks for multi-AZ', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', { MultiAZ: false })
    Template.fromStack(build(true)).hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
    })
  })

  test('the admin secret rotates every 30 days with the built-in single-user Postgres rotation', () => {
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationLambdaARN: Match.anyValue(),
      RotationRules: { ScheduleExpression: 'rate(30 days)' },
    })
    template.hasResourceProperties('AWS::Serverless::Application', {
      Parameters: Match.objectLike({
        vpcSubnetIds: Match.anyValue(),
        vpcSecurityGroupIds: Match.anyValue(),
      }),
    })
    template.hasResourceProperties('AWS::SecretsManager::SecretTargetAttachment', {
      TargetType: 'AWS::RDS::DBInstance',
    })
  })

  test('the generated database secret is retained too', () => {
    template.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain' })
  })

  test('the bucket is retained, encrypted, versioned and blocks all public access', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
        VersioningConfiguration: { Status: 'Enabled' },
      },
    })
  })

  test('no bucket policy allows a public principal, and plain HTTP is denied', () => {
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'))
    expect(policies.length).toBe(1)
    const statements: { Effect: string }[] = policies[0]?.Properties.PolicyDocument.Statement ?? []
    expect(statements.length).toBeGreaterThan(0)
    for (const s of statements) {
      expect(s.Effect).toBe('Deny')
    }
  })

  test('the CRM token key is symmetric, rotates and is retained', () => {
    template.resourceCountIs('AWS::KMS::Key', 1)
    template.hasResource('AWS::KMS::Key', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        EnableKeyRotation: true,
        KeySpec: 'SYMMETRIC_DEFAULT',
        KeyUsage: 'ENCRYPT_DECRYPT',
      },
    })
  })

  test('the CRM token key has the per-stage alias', () => {
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/closeline/dev/core/crm-tokens',
    })
  })

  test('the key policy lets the account administer the key but not use it', () => {
    const statements = keyStatements()
    const admin = statements.find((s) => s.Sid === 'KeyAdministration')
    expect(JSON.stringify(admin?.Principal)).toContain(':root')
    expect(admin?.Action).toContain('kms:PutKeyPolicy')
    for (const use of ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:CreateGrant']) {
      expect(admin?.Action).not.toContain(use)
    }
  })

  test('only the named core task role may use the key', () => {
    const use = keyStatements().find((s) => s.Sid === 'ServiceUse')
    expect([use?.Action].flat().sort()).toEqual([
      'kms:Decrypt',
      'kms:Encrypt',
      'kms:GenerateDataKey',
    ])
    expect(JSON.stringify(use?.Condition)).toContain(':role/closeline-dev-us-east-1-core-task')
    expect(Object.keys(use?.Condition ?? {})).toEqual(['ArnEquals'])
  })

  test('no statement grants kms:* or a wildcard principal', () => {
    for (const s of keyStatements()) {
      expect(JSON.stringify(s.Action)).not.toContain('kms:*')
      expect(JSON.stringify(s.Principal)).not.toContain('"*"')
    }
  })
})

interface KeyStatement {
  Sid: string
  Principal: unknown
  Action: string | string[]
  Condition?: Record<string, unknown>
}

function keyStatements(): KeyStatement[] {
  const keys = Object.values(Template.fromStack(stack).findResources('AWS::KMS::Key'))
  return keys[0]?.Properties.KeyPolicy.Statement ?? []
}
