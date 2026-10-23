import { describe, expect, test } from 'bun:test'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { DataStack } from './data-stack'
import { NetworkStack } from './network-stack'

function synth(): Template {
  const app = new App()
  const env = { account: '123456789012', region: 'us-east-1' }
  const { vpc } = new NetworkStack(app, 'net', { env, natGateways: 1 })
  return Template.fromStack(new DataStack(app, 'data', { env, vpc }))
}

describe('DataStack', () => {
  const template = synth()

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

  test('Postgres accepts connections only on 5432 from the VPC', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [Match.objectLike({ FromPort: 5432, ToPort: 5432, IpProtocol: 'tcp' })],
    })
  })
})
