import { describe, expect, test } from 'bun:test'

type Step = { name?: string; uses?: string; run?: string }
type Workflow = { jobs: { deploy: { environment?: unknown; steps: Step[] } } }

const workflow = Bun.YAML.parse(
  await Bun.file(new URL('../.github/workflows/deploy.yml', import.meta.url)).text()
) as Workflow
const deploy = workflow.jobs.deploy

describe('the deploy workflow', () => {
  test('runs in the stage environment, so the OIDC subject names it', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JS
    expect(deploy.environment).toBe('${{ inputs.stage }}')
  })

  test('refuses a ref other than develop or main before it takes AWS credentials', () => {
    const guard = deploy.steps.findIndex((step) => step.name === 'refuse an unreviewed ref')
    const credentials = deploy.steps.findIndex((step) =>
      step.uses?.startsWith('aws-actions/configure-aws-credentials')
    )
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(credentials)
    const run = deploy.steps[guard]?.run ?? ''
    expect(run).toContain('refs/heads/develop')
    expect(run).toContain('refs/heads/main')
    expect(run).toContain('exit 1')
  })

  test('pairs each stage with its branch: dev and staging from develop, prod from main', () => {
    const guard = deploy.steps.find((step) => step.name === 'refuse an unreviewed ref')
    const run = guard?.run ?? ''
    const allowed = (stage: string, ref: string) =>
      Bun.spawnSync(['bash', '-c', run], { env: { STAGE: stage, GITHUB_REF: ref } }).exitCode === 0
    expect(run).toContain('$STAGE:$GITHUB_REF')
    expect(allowed('dev', 'refs/heads/develop')).toBe(true)
    expect(allowed('staging', 'refs/heads/develop')).toBe(true)
    expect(allowed('prod', 'refs/heads/main')).toBe(true)
    expect(allowed('prod', 'refs/heads/develop')).toBe(false)
    expect(allowed('dev', 'refs/heads/main')).toBe(false)
    expect(allowed('staging', 'refs/heads/main')).toBe(false)
    expect(allowed('dev', 'refs/heads/feat/x')).toBe(false)
    expect(allowed('other', 'refs/heads/develop')).toBe(false)
  })
})
