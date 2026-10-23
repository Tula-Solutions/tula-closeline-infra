import { describe, expect, test } from 'bun:test'
import { parseRegionConfig } from './config'

const base = { account: '123456789012', region: 'us-east-1', environment: 'dev' }
const service = {
  name: 'core',
  repositoryName: 'closeline/core',
  imageTag: 'v1',
  pathPatterns: ['/core/*'],
  priority: 10,
}

describe('parseRegionConfig', () => {
  test.each([
    ['a short account id', { ...base, account: '1234' }],
    ['an unknown environment', { ...base, environment: 'test' }],
    ['a malformed Region', { ...base, region: 'useast1' }],
    ['a missing account', { region: base.region, environment: base.environment }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseRegionConfig(input)).toThrow()
  })

  test('rejects a service that uses a queue the Region does not define', () => {
    const input = {
      ...base,
      services: [{ ...service, queues: [{ queue: 'jobs', envName: 'JOBS_URL', access: 'send' }] }],
    }
    expect(() => parseRegionConfig(input)).toThrow('unknown queue jobs')
  })

  test('rejects two services on one listener priority', () => {
    const input = { ...base, services: [service, { ...service, name: 'auth' }] }
    expect(() => parseRegionConfig(input)).toThrow('priority 10')
  })

  test('staging and prod must have a certificate so the ALB is not plain HTTP', () => {
    expect(() => parseRegionConfig({ ...base, environment: 'prod' })).toThrow('certificateArn')
  })

  test('rejects an environment variable that is not upper snake case', () => {
    const input = {
      ...base,
      services: [{ ...service, secrets: [{ envName: 'db-url', secretName: 'x' }] }],
    }
    expect(() => parseRegionConfig(input)).toThrow()
  })

  test('fills defaults', () => {
    const config = parseRegionConfig({ ...base, services: [service] })
    expect(config.natGateways).toBe(1)
    expect(config.services[0]?.healthCheckPath).toBe('/health')
  })
})
