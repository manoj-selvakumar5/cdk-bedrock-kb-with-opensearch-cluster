import * as cdk from 'aws-cdk-lib';
import { BedrockKbOpenSearchManagedClusterStack } from '../lib/bedrock-kb-opensearch-managed-cluster-stack';

const app = new cdk.App();
new BedrockKbOpenSearchManagedClusterStack(app, 'BedrockKbOpenSearchManagedClusterStack', {

    /* Uncomment the next line to deploy this stack in the AWS Account
     * and Region that are implied by the current CLI configuration. */
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

    /* Uncomment the next line if you know exactly what Account and Region you
     * want to deploy the stack to. */
    // env: { account: '123456789012', region: 'us-east-1' },

}); 