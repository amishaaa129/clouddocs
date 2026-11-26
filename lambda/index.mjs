
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.DOCS_TABLE || 'Documents';

const STOP = new Set(
  'about their there which would could should these those where while other being because'.split(' ')
);

export const handler = async (event) => {
  for (const record of event.Records) {
    const { docId, bucket, s3Key, contentType = '' } =
      JSON.parse(record.body);

    const isText =
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('csv');

    const update = {
      processingStatus: 'PROCESSED',
      processedAt: new Date().toISOString()
    };

    if (isText) {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: s3Key })
      );

      const content = await obj.Body.transformToString();
      const words = content.toLowerCase().match(/[a-z]{5,}/g) || [];
      const freq = {};

      words.forEach(word => {
        if (!STOP.has(word)) {
          freq[word] = (freq[word] || 0) + 1;
        }
      });

      update.keywords = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(entry => entry[0]);

      update.wordCount = content.split(/\s+/).filter(Boolean).length;
      update.preview = content.replace(/\s+/g, ' ').slice(0, 200);
    } else {
      update.preview =
        `Binary file (${contentType || 'unknown type'}) - metadata indexed only`;
      update.keywords = [];
    }

    const names = Object.keys(update);

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { docId },
      UpdateExpression:
        'SET ' + names.map((name, i) => `#n${i} = :v${i}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(
        names.map((name, i) => [`#n${i}`, name])
      ),
      ExpressionAttributeValues: Object.fromEntries(
        names.map((name, i) => [`:v${i}`, update[name]])
      )
    }));

    console.log('Processed', docId);
  }

  return { statusCode: 200 };
};
