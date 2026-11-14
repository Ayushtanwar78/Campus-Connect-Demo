# CampusConnect — Cloud-ready starter

This project follows the supplied CampusConnect Free-Account Implementation Guide baseline:
GitHub Pages frontend → AWS Lambda Function URL → DynamoDB; CloudWatch logs. S3 private bucket
and VPC gateway endpoints are planned infrastructure elements; the presigned attachment upload
flow is intentionally not implemented in this starter.

## Files
- `index.html`, `style.css`, `script.js`: static frontend
- `lambda/handler.py`: Python Lambda handler for `GET /health`, `GET /complaints`, `POST /complaints`

## Configure frontend
1. Deploy Lambda and create its Function URL.
2. In `script.js`, set `API_BASE` to the complete Function URL (normally ending in `/`).
3. Set `DEMO_MODE = false`.
4. Host frontend with GitHub Pages or run locally using a local web server.

Do not add AWS credentials or secrets to frontend code.

## AWS resources (guide baseline)
- DynamoDB table: `CampusComplaints`
  - Partition key: `complaint_id` (String)
- Lambda function: `campusconnect-api`
  - Python runtime supported by AWS Lambda console
  - Environment variables:
    - `TABLE_NAME=CampusComplaints`
    - `ALLOWED_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io` (use exact deployed origin)
  - Execution role should have least-privilege DynamoDB `PutItem` and `Scan` on the table,
    plus CloudWatch Logs permissions.
- Lambda Function URL:
  - Auth NONE is only for a fictional-data classroom prototype; endpoint is publicly callable.
  - Configure CORS for the exact frontend origin, GET/POST/OPTIONS, and content-type.
- AWS Region: use one region consistently for Lambda and DynamoDB.

## API checks
- `GET <FUNCTION_URL>health` → `{ "status": "ok" }`
- `GET <FUNCTION_URL>complaints` → `{ "items": [...] }`
- `POST <FUNCTION_URL>complaints` with JSON:
  ```json
  {
    "student_id": "student-demo-01",
    "title": "Wi-Fi not working in library",
    "category": "Wi-Fi / Internet",
    "location": "Central Library, Floor 2",
    "description": "Network disconnects repeatedly.",
    "priority": "medium"
  }
  ```

## Important limitations
- The sample student ID is a demo value, not identity verification.
- Public Function URL with Auth NONE is not production-safe; do not use real student data.
- CORS is not authentication; clients outside browsers can still call the endpoint.
- This package validates image selection in the browser but does not upload files to S3 yet.
  Add Lambda presigned URL generation, private S3 bucket permissions, and appropriate S3 CORS
  before enabling real attachments.
- The list operation uses DynamoDB Scan with Limit 50, suitable only for a small demo.
- AWS free allowances, account plan, limits, and cost can vary. Check the AWS billing/credits view.
- Do not create NAT Gateway, ALB, EC2, RDS, or other resources omitted by the supplied guide
  for this baseline unless you intentionally accept possible charges.
