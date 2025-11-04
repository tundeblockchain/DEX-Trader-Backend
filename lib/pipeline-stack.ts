import * as cdk from 'aws-cdk-lib';
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';
import { DexPlatformStage } from './dex-platform-stage';

export class PipelineStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const repoOwner = process.env.GITHUB_OWNER ?? 'your-github-user';
    const repoName = process.env.GITHUB_REPO ?? 'trading-platform';
    const repoBranch = process.env.GITHUB_BRANCH ?? 'main';

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'DEXTradingPlatformPipeline',
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.gitHub(`${repoOwner}/${repoName}`, repoBranch),
        commands: [
          'npm ci',
          'npm run build',
          'npx cdk synth'
        ],
      }),
    });
    pipeline.addStage(new DexPlatformStage(this, 'Development', {
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    }));
  }
}
