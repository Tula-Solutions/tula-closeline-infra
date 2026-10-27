import { describe, expect, test } from 'bun:test'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { NetworkStack } from './network-stack'

describe('NetworkStack', () => {
  test('the isolated data subnets reach Secrets Manager through an interface endpoint (for rotation)', () => {
    const app = new App()
    const stack = new NetworkStack(app, 'net', {
      env: { account: '123456789012', region: 'us-east-1' },
      natGateways: 1,
    })
    const template = Template.fromStack(stack)
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: 'com.amazonaws.us-east-1.secretsmanager',
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true,
    })
    const endpoint = Object.values(template.findResources('AWS::EC2::VPCEndpoint'))[0]
    const subnetIds: { Ref: string }[] = endpoint?.Properties.SubnetIds
    expect(subnetIds).toHaveLength(2)
    for (const { Ref } of subnetIds) {
      expect(Ref).toContain('dataSubnet')
    }
  })

  test.each([1, 2])('natGateways: %i creates exactly that many NAT gateways', (natGateways) => {
    const stack = new NetworkStack(new App(), 'net', {
      env: { account: '123456789012', region: 'us-east-1' },
      natGateways,
    })
    Template.fromStack(stack).resourceCountIs('AWS::EC2::NatGateway', natGateways)
  })
})
