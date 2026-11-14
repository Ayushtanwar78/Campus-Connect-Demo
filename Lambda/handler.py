import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]
table = boto3.resource("dynamodb").Table(TABLE_NAME)

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
                "attachment_key": "",
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
