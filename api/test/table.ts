import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** The secrets table as the stack defines it (key, sweep-due index), for DynamoDB Local. */
export async function createSecretsTable(db: DynamoDBDocumentClient, name: string): Promise<void> {
  await db.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sweepPart', AttributeType: 'S' },
        { AttributeName: 'sweepAt', AttributeType: 'N' },
      ],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'sweep-due',
          KeySchema: [
            { AttributeName: 'sweepPart', KeyType: 'HASH' },
            { AttributeName: 'sweepAt', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: ['status', 'fileIds', 'createdAt', 'endedAt', 'expiresAt'],
          },
        },
      ],
    }),
  );
}
