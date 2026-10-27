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
})
