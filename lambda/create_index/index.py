import json
import boto3
import time
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import urllib.request
import urllib.parse
import urllib.error
import os
import re

def make_signed_request(method, url, region, payload=''):
    """Make a signed request to OpenSearch using boto3's SigV4 signing"""
    # This allows the Lambda function to make requests to OpenSearch using IAM authentication
    session = boto3.Session()
    credentials = session.get_credentials()
    
    # Create AWS request
    request = AWSRequest(method=method, url=url, data=payload, headers={'Content-Type': 'application/json'})
    
    # Sign the request
    SigV4Auth(credentials, 'es', region).add_auth(request)
    
    # Ensure body is bytes (urllib expects bytes for data)
    if request.body is None:
        body_data = None
    elif isinstance(request.body, bytes):
        body_data = request.body
    else:
        body_data = str(request.body).encode('utf-8')

    req = urllib.request.Request(
        url=request.url,
        data=body_data,
        headers=dict(request.headers)
    )
    req.get_method = lambda: method
    
    try:
        with urllib.request.urlopen(req) as response:
            return response.getcode(), response.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8')

def handler(event, context):
    print(f"Event: {json.dumps(event, default=str)}")
    
    try:
        props = event['ResourceProperties']
        domain_endpoint = props['DomainEndpoint']
        index_name = props['IndexName']
        region = props['Region']
        kb_role_arn = props['KbRoleArn']
        admin_role_arn = props.get('AdminRoleArn')
        request_type = event.get('RequestType', 'Create')
        
        # Clean up the domain endpoint
        if domain_endpoint.startswith('https://'):
            domain_endpoint = domain_endpoint[8:]
        if domain_endpoint.startswith('http://'):
            domain_endpoint = domain_endpoint[7:]
        
        base_url = f"https://{domain_endpoint}"
        
        if request_type == 'Delete':
            print("Cleaning up roles and mappings...")
            # don't delete the index on cleanup, just roles if they exist
            return {
                'statusCode': 200,
                'body': json.dumps('Cleaned up role and mappings')
            }
        
        print("Using IAM authentication with boto3 SigV4 signing")
        
        # Wait for OpenSearch cluster to be ready
        print("Waiting for OpenSearch cluster to be ready...")
        max_retries = 30
        for i in range(max_retries):
            try:
                status_code, response = make_signed_request('GET', f"{base_url}/_cluster/health", region)
                if status_code == 200:
                    health = json.loads(response)
                    if health.get('status') in ['green', 'yellow']:
                        print(f"Cluster is ready with status: {health.get('status')}")
                        break
                print(f"Cluster not ready yet (attempt {i+1}/{max_retries}), waiting...")
                time.sleep(10)
            except Exception as e:
                print(f"Error checking cluster health: {e}")
                if i == max_retries - 1:
                    raise
                time.sleep(10)
        
        # ==== OPENSEARCH ROLE CREATION ====
        # Create internal OpenSearch role with minimum permissions required by Bedrock KB
        # This follows AWS documentation for Fine-Grained Access Control configuration
        bedrock_kb_role = {
            # CLUSTER-LEVEL PERMISSIONS: Operations that affect the entire cluster
            "cluster_permissions": [
                "indices:data/read/msearch",    # Multi-search across indices
                "indices:data/write/bulk*",     # Bulk operations for efficient ingestion
                "indices:data/read/mget*",      # Multi-get operations for retrieving multiple docs
            ],
            # INDEX-LEVEL PERMISSIONS: Operations on specific indices/documents
            "index_permissions": [
                {
                    "index_patterns": ["*"],    # Apply to all indices (can be restricted to specific patterns)
                    "allowed_actions": [
                        # Administrative actions
                        "indices:admin/get",                   # Get index information
                        "indices:admin/mapping/put",           # Update index mappings
                        
                        # Read operations  
                        "indices:data/read/msearch",           # Multi-search queries
                        "indices:data/read/search",            # Single search queries
                        "indices:data/read/mget*",             # Multi-get document retrieval
                        
                        # Write operations
                        "indices:data/write/index",            # Index new documents
                        "indices:data/write/update",           # Update existing documents
                        "indices:data/write/delete",           # Delete specific documents
                        "indices:data/write/delete/byquery",   # Delete documents by query
                        "indices:data/write/bulk*",            # Bulk write operations
                    ]
                }
            ]
        }
        
        # Create the OpenSearch internal role via Security API
        status_code, response = make_signed_request(
            'PUT', 
            f"{base_url}/_plugins/_security/api/roles/bedrock_kb_role",
            region,
            json.dumps(bedrock_kb_role)
        )
        print(f"Create role response: {status_code} - {response}")
        
        # ==== ROLE MAPPING SECTION ====
        # Role mapping creates the bridge between AWS IAM roles (external identity) 
        # and OpenSearch internal roles (permissions within OpenSearch cluster)
        # This is required for Fine-Grained Access Control (FGAC) in OpenSearch
        
        # Prepare list of AWS IAM role ARNs that need OpenSearch access
        backend_roles = [kb_role_arn]  # Always include the Bedrock Knowledge Base service role
        if admin_role_arn and admin_role_arn not in backend_roles:
            backend_roles.append(admin_role_arn)  # Add Lambda admin role for management access

        # MAPPING 1: Map IAM roles to OpenSearch built-in "all_access" role
        # Purpose: Gives comprehensive admin permissions for management and troubleshooting
        # Who gets this: Both Knowledge Base role and Admin role
        role_mapping = {
            "backend_roles": backend_roles,  # AWS IAM role ARNs
            "hosts": [],                     # No IP restrictions
            "users": []                      # No internal users
        }
        
        # Apply the mapping: AWS IAM roles → OpenSearch "all_access" role
        status_code, response = make_signed_request(
            'PUT',
            f"{base_url}/_plugins/_security/api/rolesmapping/all_access",
            region,
            json.dumps(role_mapping)
        )
        print(f"All_access mapping response: {status_code} - {response}")
        
        # MAPPING 2: Map ONLY Knowledge Base role to custom "bedrock_kb_role"  
        # Purpose: Provides minimum required permissions for Bedrock KB operations
        # Who gets this: Only the Knowledge Base service role (not admin)
        # Why separate mapping: Follows principle of least privilege
        kb_only_mapping = {
            "backend_roles": [kb_role_arn],  # Only the KB service role
            "hosts": [],
            "users": []
        }

        # Apply the mapping: KB IAM role → OpenSearch "bedrock_kb_role"
        status_code, response = make_signed_request(
            'PUT',
            f"{base_url}/_plugins/_security/api/rolesmapping/bedrock_kb_role",
            region,
            json.dumps(kb_only_mapping)
        )
        print(f"Custom role mapping response: {status_code} - {response}")
        
        # RESULT: Knowledge Base role has BOTH mappings (all_access + bedrock_kb_role)
        # RESULT: Admin role has ONE mapping (all_access only)
        # This ensures KB has full access while maintaining AWS documentation compliance
        
        print("Custom role mapping done")
        
        # Wait for role mappings to propagate
        print("Waiting for role mappings to propagate...")
        time.sleep(30)
        
        # Create index with AWS documentation compliant settings
        index_config = {
            "settings": {
                "index": {
                    "knn": True
                }
            },
            "mappings": {
                "properties": {
                    "embeddings": {
                        "type": "knn_vector",
                        "dimension": 1024,
                        "space_type": "l2",
                        "method": {
                            "name": "hnsw",
                            "engine": "faiss",
                            "parameters": {
                                "ef_construction": 128,
                                "m": 24
                            }
                        }
                    },
                    "AMAZON_BEDROCK_METADATA": {
                        "type": "text",
                        "index": False
                    },
                    "AMAZON_BEDROCK_TEXT_CHUNK": {
                        "type": "text",
                        "index": True
                    }
                }
            }
        }
        
        # Create the index
        status_code, response = make_signed_request(
            'PUT',
            f"{base_url}/{index_name}",
            region,
            json.dumps(index_config)
        )
        print(f"Create index response: {status_code} - {response}")
        
        if status_code not in [200, 201]:
            raise Exception(f"Failed to create index: {response}")
        
        return {
            'statusCode': 200,
            'body': json.dumps('Index created successfully with IAM authentication')
        }
        
    except Exception as e:
        print(f"Error in create operation: {e}")
        raise Exception(f"Failed to create index: {e}") 