import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

@Injectable()
export class CognitoAuthGuard implements CanActivate {
  private readonly verifier;

  constructor(config: ConfigService) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: config.getOrThrow<string>('COGNITO_USER_POOL_ID'),
      clientId: config.getOrThrow<string>('COGNITO_CLIENT_ID'),
      tokenUse: 'access',
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      req.user = await this.verifier.verify(header.slice(7));
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
