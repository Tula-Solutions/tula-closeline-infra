import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { stages } from '../config/stages'
import { parseRegionConfig } from '../lib/config'
import { RegionStage } from '../lib/region-stage'

// Synthesises every stage with a dummy account so `bun run verify` needs no AWS credentials.
// Any stack that fails to synthesise, or any CDK error annotation, fails the gate.
const outdir = mkdtempSync(join(tmpdir(), 'closeline-synth-'))
const app = new cdk.App({ outdir, analyticsReporting: false })
for (const [name, definition] of Object.entries(stages)) {
  new RegionStage(app, name, parseRegionConfig({ ...definition, account: '000000000000' }))
}
const assembly = app.synth()
let count = 0
for (const stage of assembly.nestedAssemblies) {
  for (const stack of stage.nestedAssembly.stacks) {
    count += 1
    const errors = stack.messages.filter((m) => m.level === 'error')
    if (errors.length > 0) {
      console.error(`${stack.stackName}: ${errors.map((e) => e.entry.data).join('; ')}`)
      process.exit(1)
    }
  }
}
console.log(
  `synth-check: ${count} stacks across ${Object.keys(stages).length} stage(s) synthesised`
)
