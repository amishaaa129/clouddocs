
# CloudDocs – Secure Cloud-Based Document Management System

CloudDocs is a secure cloud-based document management application built using Node.js, Express.js and AWS services.

## Architecture

- **Amazon EC2:** Hosts the Node.js/Express backend and web application.
- **Amazon S3:** Stores uploaded documents privately with AES-256 server-side encryption.
- **Amazon DynamoDB:** Stores user information and document metadata.
- **Amazon SQS:** Queues asynchronous document-processing requests.
- **AWS Lambda:** Consumes SQS messages and processes document metadata.
- **AWS IAM:** Controls access to AWS resources.
- **Amazon CloudWatch:** Stores Lambda execution logs.

## Features

- User registration and login with JWT authentication.
- Document upload and private cloud storage.
- Document search and retrieval.
- Controlled document sharing.
- User-level access isolation.
- Asynchronous document processing using SQS and Lambda.
- Document processing status tracking.

## Project Structure

```text
clouddocs/
├── backend/
│   ├── public/
│   │   └── index.html
│   ├── server.js
│   ├── worker.js
│   └── package.json
├── lambda/
│   └── index.mjs
├── deploy.sh
├── README.md
└── .gitignore
```

## Document Processing Workflow

1. A user uploads a document through the web application.
2. The backend stores the document in Amazon S3.
3. Document metadata is saved in DynamoDB.
4. The backend sends a processing message to Amazon SQS.
5. AWS Lambda receives the message through an SQS event source mapping.
6. Lambda processes the document metadata and updates its status in DynamoDB.
7. The application displays the updated processing status.

PDF and other binary files currently receive metadata-only processing. Text-based files support basic preview and keyword extraction.

## Deployment

The application backend runs on Amazon EC2. Background processing is performed by AWS Lambda through an SQS event source mapping.

Configure AWS credentials and IAM permissions before deployment. Do not commit AWS credentials, private keys, or environment files.
