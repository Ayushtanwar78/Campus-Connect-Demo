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
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")

table = boto3.resource("dynamodb").Table(TABLE_NAME)
s3 = boto3.client("s3")
sns = boto3.client("sns")


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": json.dumps(body, default=str),
    }


def send_new_complaint_notification(item):
    """SNS notification function retained for future use."""

    if not SNS_TOPIC_ARN:
        print("SNS_TOPIC_ARN is not configured")
        return

    message = f"""
A new complaint has been registered in CampusConnect.

Complaint ID: {item['complaint_id']}
Title: {item['title']}
Category: {item['category']}
Location: {item['location']}
Priority: {item['priority'].upper()}
Status: {item['status'].upper()}
Date: {item['created_at']}

Image attached: {"Yes" if item.get("attachment_key") else "No"}

Please log in to the CampusConnect dashboard to review this complaint.
"""

    try:
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject="New CampusConnect Complaint",
            Message=message
        )

        print("SNS notification published successfully")

    except ClientError as error:
        print("SNS notification failed:", error.response["Error"]["Code"])

    except Exception as error:
        print("Unexpected SNS notification error:", str(error))


def lambda_handler(event, context):

    method = event.get(
        "requestContext", {}
    ).get("http", {}).get("method", "GET")

    path = event.get("rawPath", "/").rstrip("/") or "/"

    if method == "OPTIONS":
        return response(200, {"ok": True})

    if method == "GET" and path == "/health":
        return response(200, {"status": "ok"})

    # Generate S3 presigned upload URL
    if method == "POST" and path == "/upload-url":
        try:
            body = json.loads(event.get("body") or "{}")

            content_type = body.get("content_type", "")

            allowed_types = {
                "image/jpeg": "jpg",
                "image/png": "png"
            }

            if content_type not in allowed_types:
                return response(
                    400,
                    {"error": "Only JPEG and PNG images are allowed"}
                )

            try:
                file_size = int(body.get("file_size", 0))
            except (TypeError, ValueError):
                return response(400, {"error": "Invalid file size"})

            if file_size <= 0 or file_size > 5 * 1024 * 1024:
                return response(
                    400,
                    {"error": "Image must be between 1 byte and 5 MB"}
                )

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

            return response(
                200,
                {
                    "upload_url": upload_url,
                    "attachment_key": object_key
                }
            )

        except ClientError:
            print("S3 presigned URL generation failed")
            return response(
                500,
                {"error": "Could not generate upload URL"}
            )

        except json.JSONDecodeError:
            return response(400, {"error": "Invalid JSON"})

        except Exception as error:
            print("Unexpected S3 upload URL error:", str(error))
            return response(500, {"error": "Internal server error"})

    # Get complaints from DynamoDB
    if method == "GET" and path == "/complaints":
        try:
            result = table.scan(Limit=50)
            items = result.get("Items", [])

            return response(200, {"items": items})

        except ClientError as error:
            print("DynamoDB scan failed:", error)
            return response(
                500,
                {"error": "Could not load complaints"}
            )

    # Register a new complaint
    if method == "POST" and path == "/complaints":
        try:
            body = json.loads(event.get("body") or "{}")

            if not isinstance(body, dict):
                return response(
                    400,
                    {"error": "Request body must be a JSON object"}
                )

            required = [
                "student_id",
                "title",
                "category",
                "location",
                "description"
            ]

            if any(
                not str(body.get(key, "")).strip()
                for key in required
            ):
                return response(
                    400,
                    {"error": "Missing required fields"}
                )

            priority = str(
                body.get("priority", "medium")
            ).lower()

            if priority not in {"low", "medium", "high"}:
                return response(
                    400,
                    {"error": "Priority must be low, medium, or high"}
                )

            # Validate attachment
            attachment_key = str(
                body.get("attachment_key", "")
            ).strip()

            if attachment_key:

                if not re.fullmatch(
                    r"attachments/[0-9a-fA-F-]{36}\.(jpg|png)",
                    attachment_key
                ):
                    return response(
                        400,
                        {"error": "Invalid attachment key"}
                    )

                try:
                    uploaded_file = s3.head_object(
                        Bucket=S3_BUCKET,
                        Key=attachment_key
                    )

                    if uploaded_file.get("ContentLength", 0) > 5 * 1024 * 1024:
                        return response(
                            400,
                            {"error": "Image exceeds 5 MB"}
                        )

                    if uploaded_file.get("ContentType") not in {
                        "image/jpeg",
                        "image/png"
                    }:
                        return response(
                            400,
                            {"error": "Invalid image type"}
                        )

                except ClientError:
                    return response(
                        400,
                        {"error": "Uploaded image not found"}
                    )

            # Create complaint record
            current_time = datetime.now(timezone.utc).isoformat()

            item = {
                "complaint_id": str(uuid.uuid4()),
                "student_id": str(body["student_id"]).strip()[:100],
                "title": str(body["title"]).strip()[:160],
                "category": str(body["category"]).strip()[:80],
                "location": str(body["location"]).strip()[:160],
                "description": str(body["description"]).strip()[:3000],
                "priority": priority,
                "status": "submitted",
                "created_at": current_time,
                "updated_at": current_time,
                "attachment_key": attachment_key
            }

            # Save complaint in DynamoDB
            table.put_item(Item=item)

            print("Complaint saved successfully:", item["complaint_id"])

            # SNS notification temporarily disabled
            print("SNS notification temporarily disabled")

            return response(201, {"item": item})

        except json.JSONDecodeError:
            return response(400, {"error": "Invalid JSON"})

        except ClientError as error:
            print("DynamoDB or S3 operation failed:", error)
            return response(
                500,
                {"error": "Could not save complaint"}
            )

        except Exception as error:
            print("Unexpected complaint error:", str(error))
            return response(
                500,
                {"error": "Internal server error"}
            )

    return response(404, {"error": "Not found"})