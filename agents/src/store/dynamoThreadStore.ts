import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ThreadMemory, ThreadStore } from './threadStore.js';

const TTL_SECONDS = 60 * 60 * 24;

export class DynamoThreadStore implements ThreadStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client = new DynamoDBClient({}),
  ) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get<S>(threadId: string): Promise<ThreadMemory<S> | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tableName, Key: { threadId } }));
    if (!Item) return undefined;
    const { threadId: _id, expiresAt: _ttl, ...memory } = Item;
    return memory as ThreadMemory<S>;
  }

  async save<S>(threadId: string, memory: ThreadMemory<S>): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.tableName,
      Item: { ...memory, threadId, expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS },
    }));
  }
}
