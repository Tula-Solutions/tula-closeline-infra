import { describe, expect, test } from 'bun:test'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { EdgeStack } from './edge-stack'
import { NetworkStack } from './network-stack'

const env = { account: '123456789012', region: 'us-east-1' }

function synth(certificateArn?: string, deletionProtection = false): Template {
  const app = new App()
  const { vpc } = new NetworkStack(app, 'net', { env, natGateways: 1 })
  return Template.fromStack(
    new EdgeStack(app, 'edge', { env, vpc, certificateArn, deletionProtection })
  )
}

describe('EdgeStack listeners', () => {
  test('without a certificate (dev) the only listener is plain HTTP on 80 with a 404 default', () => {
    const template = synth()
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1)
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [Match.objectLike({ Type: 'fixed-response' })],
    })
  })

  test('with a certificate the ALB serves HTTPS on 443 and 80 redirects to it', () => {
    const template = synth('arn:aws:acm:us-east-1:123456789012:certificate/abc')
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2)
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' }],
      DefaultActions: [Match.objectLike({ Type: 'fixed-response' })],
    })
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({
            Protocol: 'HTTPS',
            Port: '443',
            StatusCode: 'HTTP_301',
          }),
        }),
      ],
    })
    const forwards = JSON.stringify(
      Object.values(template.findResources('AWS::ElasticLoadBalancingV2::Listener'))
    )
    expect(forwards).not.toContain('"forward"')
  })
})

describe('EdgeStack protection and logs', () => {
  const attributes = (template: Template): { Key: string; Value: string }[] =>
    Object.values(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))[0]
      ?.Properties.LoadBalancerAttributes ?? []

  test('deletion protection follows the prop', () => {
    expect(attributes(synth(undefined, true))).toContainEqual({
      Key: 'deletion_protection.enabled',
      Value: 'true',
    })
    expect(attributes(synth())).not.toContainEqual({
      Key: 'deletion_protection.enabled',
      Value: 'true',
    })
  })

  test('access logs go to a private, encrypted, TLS-only bucket that expires them', () => {
    const template = synth()
    expect(attributes(template)).toContainEqual({ Key: 'access_logs.s3.enabled', Value: 'true' })
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: {
          Rules: [Match.objectLike({ ExpirationInDays: 90, Status: 'Enabled' })],
        },
      },
    })
    expect(JSON.stringify(template.toJSON().Resources)).toContain('"aws:SecureTransport":"false"')
  })
})
