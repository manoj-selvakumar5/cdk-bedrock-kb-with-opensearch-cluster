import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

export class BedrockKbOpenSearchManagedClusterStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // IAM role for OpenSearch admin access
        const openSearchAdminRole = new iam.Role(this, 'OpenSearchAdminRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceFullAccess'),
            ],
            description: 'IAM role for OpenSearch domain admin access',
        });

        // Create OpenSearch managed cluster with the similar configuration as "Easy create" option in AWS console
        const openSearchDomain = new opensearch.Domain(this, 'BedrockKBOpenSearchDomain', {
            version: opensearch.EngineVersion.OPENSEARCH_2_19, // Using 2.13+ as required

            // Multi-AZ with standby deployment 
            capacity: {
                dataNodes: 3, // 3 data nodes (Active:2, Standby:1)
                dataNodeInstanceType: 'r7g.large.search',
                masterNodes: 3, // 3 dedicated master nodes
                masterNodeInstanceType: 'm7g.large.search',
                multiAzWithStandbyEnabled: true,
            },

            // Zone awareness configuration (required for Multi-AZ)
            zoneAwareness: {
                enabled: true,
                availabilityZoneCount: 3, // 3-AZ deployment
            },

            // EBS storage configuration (Easy create defaults)
            ebs: {
                volumeSize: 100, // 100 GB per node
                volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
                throughput: 125, // 125 MiB/s provisioned throughput
                iops: 3000, // 3000 provisioned IOPS
            },

            // Security and encryption (Easy create defaults)
            encryptionAtRest: {
                enabled: true, // Using AWS owned KMS key
            },
            nodeToNodeEncryption: true,
            enforceHttps: true,

            // Fine-grained access control with IAM authentication
            fineGrainedAccessControl: {
                masterUserArn: openSearchAdminRole.roleArn,
            },

            // Auto-Tune enabled (Easy create default)
            enableAutoSoftwareUpdate: true,

            // Advanced settings
            advancedOptions: {
                'rest.action.multi.allow_explicit_index': 'true',
                'indices.query.bool.max_clause_count': '1024',
            },

            // Explicitly configure for public access (no VPC) - required for Bedrock KB
            // Note: Security is handled through FGAC and access policies, not network isolation
            // Domain is public by default when no VPC is specified

            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development; set to RETAIN for production
        });

        // S3 bucket for knowledge base data source
        const knowledgeBaseBucket = new s3.Bucket(this, 'BedrockKBDataBucket', {
            bucketName: `bedrock-kb-data-${this.account}-${this.region}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
            autoDeleteObjects: true, // For development
        });

        // Bedrock Knowledge Base service role
        const knowledgeBaseRole = new iam.Role(this, 'BedrockKBServiceRole', {
            assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com').withConditions({
                StringEquals: {
                    'aws:SourceAccount': this.account,
                },
                ArnLike: {
                    'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
                },
            }),
            description: 'Bedrock Knowledge Base service role to access OpenSearch and S3',
        });

        // 1. Bedrock Models Policy
        const bedrockModelsPolicy = new iam.ManagedPolicy(this, 'BedrockModelsPolicy', {
            managedPolicyName: 'BedrockKB-ModelsAccess',
            description: 'Allows access to Bedrock foundation models for embeddings',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'bedrock:ListFoundationModels',
                        'bedrock:ListCustomModels',
                    ],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'bedrock:InvokeModel',
                    ],
                    resources: [
                        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
                    ],
                }),
            ],
        });

        // 2. OpenSearch Access Policy
        const openSearchAccessPolicy = new iam.ManagedPolicy(this, 'OpenSearchAccessPolicy', {
            managedPolicyName: 'BedrockKB-OpenSearchAccess',
            description: 'Allows Bedrock Knowledge Base to access OpenSearch cluster',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'es:ESHttpPost',
                        'es:ESHttpPut',
                        'es:ESHttpGet',
                        'es:ESHttpDelete',
                        'es:ESHttpHead',
                    ],
                    resources: [openSearchDomain.domainArn + '/*'],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'es:DescribeDomain',
                    ],
                    resources: [openSearchDomain.domainArn],
                }),
            ],
        });

        // 3. S3 Data Access Policy
        const s3DataAccessPolicy = new iam.ManagedPolicy(this, 'S3DataAccessPolicy', {
            managedPolicyName: 'BedrockKB-S3DataAccess',
            description: 'Allows Bedrock Knowledge Base to read data from S3 bucket',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        's3:GetObject',
                        's3:ListBucket',
                    ],
                    resources: [
                        knowledgeBaseBucket.bucketArn,
                        knowledgeBaseBucket.bucketArn + '/*',
                    ],
                    conditions: {
                        StringEquals: {
                            'aws:ResourceAccount': [this.account],
                        },
                    },
                }),
            ],
        });

        // 4. Attach all policies to the Knowledge Base role
        knowledgeBaseRole.addManagedPolicy(bedrockModelsPolicy);
        knowledgeBaseRole.addManagedPolicy(openSearchAccessPolicy);
        knowledgeBaseRole.addManagedPolicy(s3DataAccessPolicy);

        // Lambda function to create OpenSearch index with IAM auth
        const createIndexFunction = new lambda.Function(this, 'CreateIndexFunction', {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/create_index')),
            timeout: cdk.Duration.minutes(5),
            role: openSearchAdminRole,
        });


        // Update OpenSearch resource-based access policy to include the Knowledge Base role and Lambda
        const accessPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [
                knowledgeBaseRole,
                createIndexFunction.role!,
                new iam.AccountRootPrincipal(), // Account root for management access
            ],
            actions: [
                'es:ESHttpGet',
                'es:ESHttpPost',
                'es:ESHttpPut',
                'es:ESHttpDelete',
                'es:ESHttpHead',
            ],
            resources: [openSearchDomain.domainArn + '/*'],
        });

        openSearchDomain.addAccessPolicies(accessPolicy);

        // Custom resource to create the index with IAM authentication
        const indexCreator = new cr.AwsCustomResource(this, 'OpenSearchIndexCreator', {
            onCreate: {
                service: 'Lambda',
                action: 'invoke',
                parameters: {
                    FunctionName: createIndexFunction.functionName,
                    Payload: JSON.stringify({
                        ResourceProperties: {
                            DomainEndpoint: openSearchDomain.domainEndpoint,
                            IndexName: 'bedrock-kb-index',
                            Region: this.region,
                            KbRoleArn: knowledgeBaseRole.roleArn,
                            AdminRoleArn: openSearchAdminRole.roleArn,
                        },
                        RequestType: 'Create',
                    }),
                },
                physicalResourceId: cr.PhysicalResourceId.of('index-creator'),
            },
            onDelete: {
                service: 'Lambda',
                action: 'invoke',
                parameters: {
                    FunctionName: createIndexFunction.functionName,
                    Payload: JSON.stringify({
                        ResourceProperties: {
                            DomainEndpoint: openSearchDomain.domainEndpoint,
                            IndexName: 'bedrock-kb-index',
                            Region: this.region,
                            KbRoleArn: knowledgeBaseRole.roleArn,
                            AdminRoleArn: openSearchAdminRole.roleArn,
                        },
                        RequestType: 'Delete',
                    }),
                },
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['lambda:InvokeFunction'],
                    resources: [createIndexFunction.functionArn],
                }),
            ]),
        });

        // Ensure index is created after OpenSearch domain is ready
        indexCreator.node.addDependency(openSearchDomain);

        // Bedrock Knowledge Base with proper field mapping
        const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'BedrockKnowledgeBase', {
            name: 'bedrock-opensearch-knowledge-base',
            description: 'Knowledge Base with OpenSearch managed cluster vector store',
            roleArn: knowledgeBaseRole.roleArn,
            knowledgeBaseConfiguration: {
                type: 'VECTOR',
                vectorKnowledgeBaseConfiguration: {
                    embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
                    embeddingModelConfiguration: {
                        bedrockEmbeddingModelConfiguration: {
                            dimensions: 1024, // Titan Text Embeddings v2 default dimensions
                        },
                    },
                },
            },
            storageConfiguration: {
                type: 'OPENSEARCH_MANAGED_CLUSTER',
                opensearchManagedClusterConfiguration: {
                    domainArn: openSearchDomain.domainArn,
                    domainEndpoint: `https://${openSearchDomain.domainEndpoint}`,
                    vectorIndexName: 'bedrock-kb-index',
                    fieldMapping: {
                        vectorField: 'embeddings', // Matching the index field name
                        textField: 'AMAZON_BEDROCK_TEXT_CHUNK', // Matching the index field name
                        metadataField: 'AMAZON_BEDROCK_METADATA', // Matching the index field name
                    },
                },
            },
        });

        // Ensure Knowledge Base is created after index exists
        knowledgeBase.node.addDependency(indexCreator);

        // Data Source for the Knowledge Base
        const dataSource = new bedrock.CfnDataSource(this, 'BedrockKBDataSource', {
            knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
            name: 's3-data-source',
            description: 'S3 data source for knowledge base',
            dataSourceConfiguration: {
                type: 'S3',
                s3Configuration: {
                    bucketArn: knowledgeBaseBucket.bucketArn,
                    inclusionPrefixes: ['documents/'], // Optional: specify prefixes
                },
            },
            vectorIngestionConfiguration: {
                chunkingConfiguration: {
                    chunkingStrategy: 'FIXED_SIZE',
                    fixedSizeChunkingConfiguration: {
                        maxTokens: 512,
                        overlapPercentage: 20,
                    },
                },
            },
        });

        // Output important values
        new cdk.CfnOutput(this, 'OpenSearchDomainEndpoint', {
            value: openSearchDomain.domainEndpoint,
            description: 'OpenSearch domain endpoint',
        });

        new cdk.CfnOutput(this, 'OpenSearchDomainArn', {
            value: openSearchDomain.domainArn,
            description: 'OpenSearch domain ARN',
        });

        new cdk.CfnOutput(this, 'OpenSearchDashboardsUrl', {
            value: `https://${openSearchDomain.domainEndpoint}/_dashboards/`,
            description: 'OpenSearch Dashboards URL for management',
        });

        new cdk.CfnOutput(this, 'KnowledgeBaseId', {
            value: knowledgeBase.attrKnowledgeBaseId,
            description: 'Bedrock Knowledge Base ID',
        });

        new cdk.CfnOutput(this, 'KnowledgeBaseBucketName', {
            value: knowledgeBaseBucket.bucketName,
            description: 'S3 bucket for knowledge base data',
        });

        new cdk.CfnOutput(this, 'DataSourceId', {
            value: dataSource.attrDataSourceId,
            description: 'Knowledge Base Data Source ID',
        });

        new cdk.CfnOutput(this, 'KnowledgeBaseRoleArn', {
            value: knowledgeBaseRole.roleArn,
            description: 'Knowledge Base IAM Role ARN',
        });

        new cdk.CfnOutput(this, 'OpenSearchIndexName', {
            value: 'bedrock-kb-index',
            description: 'OpenSearch vector index name',
        });

        new cdk.CfnOutput(this, 'OpenSearchAdminRoleArn', {
            value: openSearchAdminRole.roleArn,
            description: 'IAM role with OpenSearch admin access',
        });
    }
} 