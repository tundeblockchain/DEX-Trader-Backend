import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DexTraderBackendStack } from './dex-trader-backend-stack';

export interface DexPlatformStageProps extends cdk.StageProps {}

export class DexPlatformStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: DexPlatformStageProps) {
    super(scope, id, props);

    // Instantiate the stacks that belong to this Stage
    new DexTraderBackendStack(this, 'DEXTradingPlatformStack', {
      /* optionally pass stack props here */
    });
  }
}
