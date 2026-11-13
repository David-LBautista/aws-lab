#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfraStack } from '../lib/infra-stack';

const app = new cdk.App();

// Cuenta y región donde se crean los recursos
const env = { account: '948630188208', region: 'us-east-1' };

// Ambiente QA creado con CDK
new InfraStack(app, 'AwsLab-Qa-Hosting', {
  env,
  envName: 'qa',
});

//! Si quisieramos crear los otros env
// new InfraStack(app, 'AwsLab-Dev-Hosting', { env, envName: 'dev' });
// new InfraStack(app, 'AwsLab-Prod-Hosting', { env, envName: 'prod' });
