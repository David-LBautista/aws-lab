import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentsStack } from '../lib/agents-stack';

function synth() {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new AgentsStack(app, 'TestAgents', {
    env: { account: '111111111111', region: 'us-east-1' },
    userPoolId: 'us-east-1_TEST',
    allowedOrigins: ['https://lab.davidlucas.dev', 'https://dev-lab.davidlucas.dev', 'http://localhost:4200'],
  });
  return Template.fromStack(stack);
}

const template = synth();

describe('AgentsStack', () => {
  test('API Gateway methods use response streaming', () => {
    const methods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: Match.anyValue(), Integration: { Type: 'AWS_PROXY' } },
    });
    const integrations = Object.values(methods).map((method: any) => method.Properties.Integration);
    expect(integrations).toHaveLength(2);
    for (const integration of integrations) {
      expect(integration.ResponseTransferMode).toBe('STREAM');
      expect(JSON.stringify(integration.Uri)).toContain('/response-streaming-invocations');
    }
  });

  test('the agent POST requires a Cognito access token', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizationScopes: ['openid'],
    });
    const authorizers = template.findResources('AWS::ApiGateway::Authorizer', {
      Properties: { Type: 'COGNITO_USER_POOLS' },
    });
    expect(Object.keys(authorizers)).toHaveLength(1);
    expect(JSON.stringify(authorizers)).toContain('userpool/us-east-1_TEST');
  });

  test('the health endpoint is public', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'GET', AuthorizationType: 'NONE' });
  });

  test('the API has stage throttling', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 })]),
    });
  });

  test('threads use on-demand DynamoDB and expire through TTL', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'threadId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('the Lambda gets CORS origins and secret name, never the API key', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({
          ALLOWED_ORIGINS: 'https://lab.davidlucas.dev,https://dev-lab.davidlucas.dev,http://localhost:4200',
          ANTHROPIC_SECRET_ID: 'aws-lab/anthropic-api-key',
          CLAUDE_GROUP: 'agents-claude',
        }),
      },
    });
    const lambdaResources = JSON.stringify(template.findResources('AWS::Lambda::Function'));
    expect(lambdaResources).not.toContain('ANTHROPIC_API_KEY');
    expect(lambdaResources).not.toMatch(/sk-ant-/);
  });

  test('the Lambda has least-privilege read access to the Anthropic secret', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          Resource: Match.objectLike({
            'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('secret:aws-lab/anthropic-api-key-\\?\\?\\?\\?\\?\\?')])]),
          }),
        })]),
      },
    });
  });

  test('creates the Cognito group allowed to use Claude', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'agents-claude',
      UserPoolId: 'us-east-1_TEST',
    });
  });

  test('API Gateway 4XX/5XX responses include CORS headers', () => {
    template.resourceCountIs('AWS::ApiGateway::GatewayResponse', 2);
    template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseType: 'DEFAULT_4XX',
      ResponseParameters: Match.objectLike({
        'gatewayresponse.header.Access-Control-Allow-Origin': "'https://lab.davidlucas.dev'",
      }),
    });
  });

  test('preflight OPTIONS exists for API resources', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
    });
  });
});
