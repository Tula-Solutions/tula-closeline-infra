import * as cdk from 'aws-cdk-lib'
import { stages } from '../config/stages'
import { parseRegionConfig } from './config'
import { RegionStage } from './region-stage'

/**
 * Builds the app with one stage per entry of `config/stages.ts`. The account is `account`, else
 * the `account` context (`-c account=...`), else CDK_DEFAULT_ACCOUNT; it is never in source.
 */
export function buildApp(account?: string): cdk.App {
  const app = new cdk.App()
  const resolved =
    account ??
    (app.node.tryGetContext('account') as string | undefined) ??
    process.env.CDK_DEFAULT_ACCOUNT
  if (!resolved) {
    throw new Error('Set the AWS account: cdk <command> -c account=<12-digit id>')
  }
  for (const [name, definition] of Object.entries(stages)) {
    new RegionStage(app, name, parseRegionConfig({ ...definition, account: resolved }))
  }
  return app
}
