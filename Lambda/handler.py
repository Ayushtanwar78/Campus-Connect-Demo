import json
import os
import uuid
import re
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]
S3_BUCKET = os.environ["S3_BUCKET"]
table = boto3.resource("dynamodb").Table(TABLE_NAME)
s3 = boto3.client("s3")

def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": json.dumps(body, default=str),
    }

def lambda_handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/").rstrip("/") or "/"

    if method == "OPTIONS":
        return response(200, {"ok": True})

    if method == "GET" and path == "/health":
        return response(200, {"status": "ok"})

    if method == "POST" and path == "/upload-url":
        try:
            body = json.loads(event.get("body") or "{}")

            content_type = body.get("content_type", "")
            allowed_types = {
                "image/jpeg": "jpg",
                "image/png": "png"
            }

            if content_type not in allowed_types:
                return response(400, {"error": "Only JPEG and PNG images are allowed"})

            try:
                file_size = int(body.get("file_size", 0))
            except (TypeError, ValueError):
                return response(400, {"error": "Invalid file size"})

            if file_size <= 0 or file_size > 5 * 1024 * 1024:
                return response(400, {"error": "Image must be between 1 byte and 5 MB"})

            extension = allowed_types[content_type]
            object_key = f"attachments/{uuid.uuid4()}.{extension}"

            upload_url = s3.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": S3_BUCKET,
                    "Key": object_key,
                    "ContentType": content_type
                },
                ExpiresIn=180
            )

            return response(200, {
                "upload_url": upload_url,
                "attachment_key": object_key
            })

        except ClientError:
            print("S3 presigned URL generation failed")
            return response(500, {"error": "Could not generate upload URL"})
        except json.JSONDecodeError:
            return response(400, {"error": "Invalid JSON"})
        except Exception:
            print("Unexpected S3 upload URL error")
            return response(500, {"error": "Internal server error"})

    if method == "GET" and path == "/complaints":
        try:
            result = table.scan(Limit=50)
            items = result.get("Items", [])
            return response(200, {"items": items})
        except ClientError:
            print("DynamoDB scan failed")
            return response(500, {"error": "Could not load complaints"})

    if method == "POST" and path == "/complaints":
        try:
            body = json.loads(event.get("body") or "{}")

            if not isinstance(body, dict):
                return response(400, {"error": "Request body must be a JSON object"})

            required = ["student_id", "title", "category", "location", "description"]

            if any(not str(body.get(key, "")).strip() for key in required):
                return response(400, {"error": "Missing required fields"})

            priority = str(body.get("priority", "medium")).lower()

            if priority not in {"low", "medium", "high"}:
                return response(400, {"error": "Priority must be low, medium, or high"})

            # Validate attachment
            attachment_key = str(body.get("attachment_key", "")).strip()

            if attachment_key:
                if not re.fullmatch(
                    r"attachments/[0-9a-fA-F-]{36}\.(jpg|png)",
                    attachment_key
                ):
                    return response(400, {"error": "Invalid attachment key"})

                try:
                    uploaded_file = s3.head_object(
                        Bucket=S3_BUCKET,
                        Key=attachment_key
                    )

                    if uploaded_file.get("ContentLength", 0) > 5 * 1024 * 1024:
                        return response(400, {"error": "Image exceeds 5 MB"})

                    if uploaded_file.get("ContentType") not in {
                        "image/jpeg",
                        "image/png"
                    }:
                        return response(400, {"error": "Invalid image type"})

                except ClientError:
                    return response(400, {"error": "Uploaded image not found"})

            # Create complaint record
            item = {
                "complaint_id": str(uuid.uuid4()),
                "student_id": str(body["student_id"]).strip()[:100],
                "title": str(body["title"]).strip()[:160],
                "category": str(body["category"]).strip()[:80],
                "location": str(body["location"]).strip()[:160],
                "description": str(body["description"]).strip()[:3000],
                "priority": priority,
                "status": "submitted",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "attachment_key": attachment_key
            }

            table.put_item(Item=item)

            return response(201, {"item": item})

        except json.JSONDecodeError:
            return response(400, {"error": "Invalid JSON"})

        except ClientError:
            print("DynamoDB put_item failed")
            return response(500, {"error": "Could not save complaint"})

        except Exception:
            print("Unexpected error while handling complaint")
            return response(500, {"error": "Internal server error"})

    return response(404, {"error": "Not found"})    