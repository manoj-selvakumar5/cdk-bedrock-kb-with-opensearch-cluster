# Bedrock Knowledge Base with OpenSearch Managed Cluster Deployment 

This guide walks you through deploying and using a Bedrock Knowledge Base integrated with an OpenSearch managed cluster for vector storage.

## Prerequisites

Before starting, ensure you have:

1. **AWS CLI configured** with appropriate credentials
2. **Node.js 18.x or later** installed
3. **AWS CDK v2** installed globally: `npm install -g aws-cdk`
4. **Bedrock model access** enabled in your AWS region 
5. **AWS account permissions** for creating OpenSearch domains, IAM roles, S3 buckets, and Lambda functions

## Architecture Overview

This solution creates:
- OpenSearch managed cluster 
- Bedrock Knowledge Base 
- S3 bucket for document storage
- IAM roles and policies with proper permissions
- Lambda function for automated OpenSearch configuration

## Step 1: Clone and Setup
```bash
# Install dependencies
npm install
```

## Step 2: Bootstrap CDK (First Time Only)
If you haven't used CDK in this AWS account/region before:

```bash
cdk bootstrap
```

## Step 3: Deploy the Stack
```bash
# Deploy the infrastructure
cdk deploy

# Confirm deployment when prompted
# Type 'y' and press Enter
```

Deployment takes approximately 15-20 minutes. The OpenSearch cluster creation is the longest step.

## Step 4: Note the Outputs
After successful deployment, save these important outputs:

- **OpenSearchDomainEndpoint**: Your OpenSearch cluster URL
- **KnowledgeBaseId**: Required for querying the knowledge base
- **KnowledgeBaseBucketName**: S3 bucket for uploading documents
- **DataSourceId**: Required for data ingestion jobs

## Step 5: Upload Documents

Upload your documents to the S3 bucket



## Step 6: Start Data Ingestion

Trigger the knowledge base ingestion to process your documents




## Configuration Details

### OpenSearch Cluster
- **Instance Type**: 3x r7g.large.search (data nodes) + 3x m7g.large.search (master nodes)
- **Storage**: 100GB GP3 per node with 3000 IOPS
- **Deployment**: Multi-AZ with standby across 3 availability zones
- **Security**: Fine-grained access control with IAM authentication

### Document Processing
- **Chunking**: Fixed-size chunks of 512 tokens with 20% overlap
- **Embeddings**: Amazon Titan Text Embeddings v2 (1024 dimensions)
- **Vector Engine**: FAISS with HNSW algorithm


## Cleanup


```bash
# Delete the stack (keeps data by default)
cdk destroy

# Confirm deletion when prompted
```

Note: The vector index and data are preserved by default. To delete everything including data, modify the Lambda cleanup function before destroying.
