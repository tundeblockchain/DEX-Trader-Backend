import * as cdk from 'aws-cdk-lib';
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';
import { DexPlatformStage } from './dex-platform-stage';
import * as iam from 'aws-cdk-lib/aws-iam';

export class PipelineStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    console.log('Setting up pipeline stack');
    const repoOwner = process.env.GITHUB_OWNER ?? 'your-github-user';
    const repoName = process.env.GITHUB_REPO ?? 'trading-platform';
    const repoBranch = process.env.GITHUB_BRANCH ?? 'master';
    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'DEXTradingPlatformPipeline',
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection(`${repoOwner}/${repoName}`, repoBranch, {
            connectionArn: process.env.CODESTAR_CONNECTION_ARN!,
        }),
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
