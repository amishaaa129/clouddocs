require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const { AWS_REGION = 'us-east-1', S3_BUCKET, USERS_TABLE = 'DocUsers', DOCS_TABLE = 'Documents',
  SQS_QUEUE_URL, JWT_SECRET, ADMIN_EMAIL, PORT = 3000 } = process.env;

if (!S3_BUCKET || !JWT_SECRET) { 
  console.error('Set S3_BUCKET and JWT_SECRET in .env'); process.exit(1); 
}

// Credentials come from the default chain: env vars locally, instance profile on EC2.
const s3 = new S3Client({ region: AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const sqs = new SQSClient({ region: AWS_REGION });

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const wrap = fn => (req, res) => fn(req, res).catch(e => { 
  console.error(e); 
  res.status(500).json({ error: e.message }); 
});

// ---------- Auth ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';

  try { 
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET); 
    next(); 
  }
  catch { 
    res.status(401).json({ error: 'Unauthorized' }); 
  }
}

const sign = u => jwt.sign({ 
  email: u.email, name: u.name, role: u.role 
}, JWT_SECRET, 
{ expiresIn: '2h' });

app.post('/api/register', wrap(async (req, res) => {

  const { name, email, password } = req.body;

  if (!name || !email || !password || password.length < 6) 
    return res.status(400).json({ 
      error: 'Name, email and password (min 6 chars) required' 
    });
  
  const key = email.toLowerCase().trim();

  const { Item } = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { email: key } }));

  if (Item) 
    return res.status(409).json({ error: 'Email already registered' });

  const user = { email: key, name, role: key === (ADMIN_EMAIL || '').toLowerCase() ? 'admin' : 'user',
    passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };

  await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: user }));

  res.json({ token: sign(user), user: { email: user.email, name, role: user.role } });
}));


app.post('/api/login', wrap(async (req, res) => {

  const key = (req.body.email || '').toLowerCase().trim();

  const { Item } = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { email: key } }));

  if (!Item || !(await bcrypt.compare(req.body.password || '', Item.passwordHash)))
    return res.status(401).json({ error: 'Invalid email or password' });
  
  res.json({ token: sign(Item), user: { email: Item.email, name: Item.name, role: Item.role } });
}));

// ---------- Documents ----------
const canAccess = (doc, u) => u.role === 'admin' || doc.owner === u.email || (doc.sharedWith || []).includes(u.email);

// Upload: S3 (encrypted) -> DynamoDB metadata -> SQS message (triggers Lambda)
app.post('/api/documents', auth, upload.single('file'), wrap(async (req, res) => {

  if (!req.file) 
    return res.status(400).json({ error: 'No file provided' });

  const docId = crypto.randomUUID();

  const fileName = req.file.originalname.replace(/[^\w.\- ]/g, '_');

  const s3Key = `${req.user.email}/${docId}/${fileName}`;

  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3Key, Body: req.file.buffer,
    ContentType: req.file.mimetype, ServerSideEncryption: 'AES256' }));

  const doc = { docId, owner: req.user.email, fileName, s3Key, size: req.file.size, contentType: req.file.mimetype,
    uploadedAt: new Date().toISOString(), sharedWith: [], processingStatus: 'PENDING' };

  await ddb.send(new PutCommand({ TableName: DOCS_TABLE, Item: doc }));

  if (SQS_QUEUE_URL) {
    await sqs.send(new SendMessageCommand({ QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify({ docId, bucket: S3_BUCKET, s3Key, contentType: doc.contentType }) }));
  }
  res.status(201).json(doc);
}));

// List + search (owned or shared with me). Scan is fine at mini-project scale.
app.get('/api/documents', auth, wrap(async (req, res) => {

  let items = [], key;

  do {
    const r = await ddb.send(new ScanCommand({ TableName: DOCS_TABLE, ExclusiveStartKey: key }));

    items = items.concat(r.Items || []); key = r.LastEvaluatedKey;

  } while (key);

  const q = (req.query.q || '').toLowerCase();

  items = items.filter(d => canAccess(d, req.user)).filter(d => !q ||
    [d.fileName, d.preview, (d.keywords || []).join(' ')].join(' ').toLowerCase().includes(q));

  items.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  res.json(items);
}));

// Download: short-lived presigned URL (bucket stays private)
app.get('/api/documents/:id/download', auth, wrap(async (req, res) => {

  const { Item: doc } = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { docId: req.params.id } }));

  if (!doc || !canAccess(doc, req.user)) return res.status(404).json({ error: 'Not found' });

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: doc.s3Key,
    ResponseContentDisposition: `attachment; filename="${doc.fileName}"` }), { expiresIn: 60 });

  res.json({ url });
}));

// Share with another registered user (owner only)
app.post('/api/documents/:id/share', auth, wrap(async (req, res) => {

  const target = (req.body.email || '').toLowerCase().trim();

  const { Item: doc } = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { docId: req.params.id } }));

  if (!doc || doc.owner !== req.user.email) 
    return res.status(403).json({ error: 'Only the owner can share' });

  const { Item: u } = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { email: target } }));

  if (!u) 
    return res.status(404).json({ error: 'That user is not registered' });

  if (target === doc.owner) 
    return res.status(400).json({ error: 'You already own this document' });

  const sharedWith = [...new Set([...(doc.sharedWith || []), target])];

  await ddb.send(new UpdateCommand({ TableName: DOCS_TABLE, Key: { docId: doc.docId },
    UpdateExpression: 'SET sharedWith = :s', ExpressionAttributeValues: { ':s': sharedWith } }));

  res.json({ sharedWith });
}));


// Revoke access from a previously shared user (owner only)
app.delete('/api/documents/:id/share', auth, wrap(async (req, res) => {
  const target = (req.body.email || '').toLowerCase().trim();

  if (!target) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const { Item: doc } = await ddb.send(
    new GetCommand({
      TableName: DOCS_TABLE,
      Key: { docId: req.params.id }
    })
  );

  if (!doc || doc.owner !== req.user.email) {
    return res.status(403).json({ error: 'Only the owner can revoke access' });
  }

  const sharedWith = (doc.sharedWith || []).filter(
    email => email !== target
  );

  await ddb.send(new UpdateCommand({
    TableName: DOCS_TABLE,
    Key: { docId: doc.docId },
    UpdateExpression: 'SET sharedWith = :s',
    ExpressionAttributeValues: {
      ':s': sharedWith
    }
  }));

  res.json({
    message: 'Access revoked successfully',
    sharedWith
  });
}));

app.delete('/api/documents/:id', auth, wrap(async (req, res) => {

  const { Item: doc } = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { docId: req.params.id } }));

  if (!doc || (doc.owner !== req.user.email && req.user.role !== 'admin')) 
    return res.status(403).json({ error: 'Not allowed' });

  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: doc.s3Key }));

  await ddb.send(new DeleteCommand({ TableName: DOCS_TABLE, Key: { docId: doc.docId } }));

  res.json({ ok: true });
}));

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => console.log(`CloudDocs running on port ${PORT}`));
