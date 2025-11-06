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
    const connectionArn = this.node.tryGetContext('connectionURN');
    
    if (!repoOwner || !repoName || !repoBranch || !connectionArn) {
      throw new Error('Missing required context values: githubOwner, githubRepo, githubBranch, or connectionURN');
    }
    
    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'DEXTradingPlatformPipeline',
      selfMutation: true,
      crossAccountKeys: false,
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection(`${repoOwner}/${repoName}`, repoBranch, {
            connectionArn: connectionArn,
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
    
    // Output instructions for webhook setup
    new cdk.CfnOutput(this, 'WebhookSetupInstructions', {
      value: `After deploying, create the GitHub webhook:
1. Go to AWS CodePipeline Console
2. Select the pipeline: DEXTradingPlatformPipeline
3. Click "Edit" > "Source" stage
4. Click "Edit" on the source action
5. Click "Connect to GitHub" and follow the prompts
6. Or manually create webhook in GitHub:
   - Go to: https://github.com/${repoOwner}/${repoName}/settings/hooks
   - The webhook URL will be provided after first pipeline execution
   - Events: push, pull_request (if needed)`,
      description: 'Instructions for setting up GitHub webhook',
    });
  }
}
