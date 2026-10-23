import { describe, expect, test } from 'bun:test'
import { parseRegionConfig, secretName } from './config'

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
      services: [{ ...service, secrets: ['db-url'] }],
    }
    expect(() => parseRegionConfig(input)).toThrow()
  })

  test('names a secret by the closeline/<environment>/<service>/<NAME> convention', () => {
    expect(secretName('dev', 'core', 'DATABASE_URL')).toBe('closeline/dev/core/DATABASE_URL')
  })

  test.each([
    ['a secret name', { secrets: ['DEMO_RATE_KEY'], environment: { DEMO_RATE_KEY: 'x' } }],
    [
      'a queue variable',
      {
        queues: [{ queue: 'q', envName: 'QUEUE_URL', access: 'both' }],
        environment: { QUEUE_URL: 'x' },
      },
    ],
    [
      'the storage variable',
      { storage: { envName: 'STORAGE_BUCKET' }, environment: { STORAGE_BUCKET: 'x' } },
    ],
    [
      'the KMS key variable',
      { kmsKey: { envName: 'CRM_TOKEN_KMS_KEY_ARN' }, environment: { CRM_TOKEN_KMS_KEY_ARN: 'x' } },
    ],
    ['ENVIRONMENT', { environment: { ENVIRONMENT: 'prod' } }],
    ['a lower-case name', { environment: { region: 'us' } }],
  ])('rejects a plain environment key that collides with %s', (_name, extra) => {
    const input = { ...base, queues: [{ name: 'q' }], services: [{ ...service, ...extra }] }
    expect(() => parseRegionConfig(input)).toThrow()
  })

  test('rejects a secret listed twice or also used as a queue variable', () => {
    expect(() =>
      parseRegionConfig({ ...base, services: [{ ...service, secrets: ['A_KEY', 'A_KEY'] }] })
    ).toThrow()
    expect(() =>
      parseRegionConfig({
        ...base,
        queues: [{ name: 'q' }],
        services: [
          {
            ...service,
            secrets: ['QUEUE_URL'],
            queues: [{ queue: 'q', envName: 'QUEUE_URL', access: 'both' }],
          },
        ],
      })
    ).toThrow()
  })

  test('accepts plain settings that do not collide', () => {
    const config = parseRegionConfig({
      ...base,
      services: [{ ...service, secrets: ['A_KEY'], environment: { REGION: 'us' } }],
    })
    expect(config.services[0]?.environment).toEqual({ REGION: 'us' })
  })

  test('fills defaults', () => {
    const config = parseRegionConfig({ ...base, services: [service] })
    expect(config.natGateways).toBe(1)
    expect(config.services[0]?.healthCheckPath).toBe('/health')
  })
})
