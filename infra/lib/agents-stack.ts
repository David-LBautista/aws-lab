import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

export interface AgentsStackProps extends StackProps {
  userPoolId: string;
  allowedOrigins: string[];
  anthropicSecretName?: string;
}

export class AgentsStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);

    const agentsDir = path.join(__dirname, '../../agents');
    const claudeGroup = 'agents-claude';

    const threads = new dynamodb.Table(this, 'Threads', {
      partitionKey: { name: 'threadId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const secretName = props.anthropicSecretName ?? 'aws-lab/anthropic-api-key';
    const anthropicKey = secrets.Secret.fromSecretNameV2(this, 'AnthropicKey', secretName);

    const fn = new NodejsFunction(this, 'AgentsFn', {
      entry: path.join(agentsDir, 'src/lambda.ts'),
      handler: 'handler',
      projectRoot: agentsDir,
      depsLockFilePath: path.join(agentsDir, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      bundling: {
        format: OutputFormat.CJS,
        target: 'node22',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        THREADS_TABLE: threads.tableName,
        ALLOWED_ORIGINS: props.allowedOrigins.join(','),
        ANTHROPIC_SECRET_ID: secretName,
        CLAUDE_GROUP: claudeGroup,
        CLAUDE_MODEL: 'claude-haiku-5-5',
        MOCK_DELAY_MS: '35',
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'AgentsLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    threads.grantReadWriteData(fn);
    anthropicKey.grantRead(fn);

    const userPool = cognito.UserPool.fromUserPoolId(this, 'UserPool', props.userPoolId);
    new cognito.CfnUserPoolGroup(this, 'ClaudeGroup', {
      userPoolId: props.userPoolId,
      groupName: claudeGroup,
      description: 'Usuarios autorizados para usar Claude en el agente de crédito',
    });

    const api = new apigw.RestApi(this, 'AgentsApi', {
      restApiName: 'aws-lab-agents',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: props.allowedOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    for (const type of [apigw.ResponseType.DEFAULT_4XX, apigw.ResponseType.DEFAULT_5XX]) {
      api.addGatewayResponse(`Cors${type.responseType}`, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': `'${props.allowedOrigins[0]}'`,
          'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        },
      });
    }

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'AgentsAuthorizer', {
      cognitoUserPools: [userPool],
    });
    const integration = new apigw.LambdaIntegration(fn, {
      responseTransferMode: apigw.ResponseTransferMode.STREAM,
      timeout: Duration.minutes(5),
    });

    const apiRoot = api.root.addResource('api');
    apiRoot.addResource('health').addMethod('GET', integration);
    apiRoot.addResource('agents').addResource('{agentId}').addMethod('POST', integration, {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizationScopes: ['openid'],
    });

    new CfnOutput(this, 'AgentsApiUrl', { value: api.url.replace(/\/$/, '') });
    new CfnOutput(this, 'ThreadsTableName', { value: threads.tableName });
  }
}
