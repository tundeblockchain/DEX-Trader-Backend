import * as cdk from 'aws-cdk-lib';
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';
import { DexPlatformStage } from './dex-platform-stage';
import * as iam from 'aws-cdk-lib/aws-iam';

export class PipelineStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    console.log('Setting up pipeline stack');
    const repoOwner = this.node.tryGetContext('githubOwner');
    const repoName = this.node.tryGetContext('githubRepo');
    const repoBranch = this.node.tryGetContext('githubBranch'); 
    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'DEXTradingPlatformPipeline',
      selfMutation: true,
      crossAccountKeys: false,
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection(`${repoOwner}/${repoName}`, repoBranch, {
            connectionArn: this.node.tryGetContext('connectionURN'),
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
