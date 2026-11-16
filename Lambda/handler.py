import json
import os
import uuid
import re
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError


# ==========================================
# AWS CONFIGURATION
# ==========================================

TABLE_NAME = os.environ["TABLE_NAME"]
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]
S3_BUCKET = os.environ["S3_BUCKET"]
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")

dynamodb = boto3.resource("dynamodb")

# Complaints table
table = dynamodb.Table(TABLE_NAME)

# Users table
users_table = dynamodb.Table("CampusUsersData")

s3 = boto3.client("s3")
sns = boto3.client("sns")


# ==========================================
# COMMON RESPONSE
# ==========================================

def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": json.dumps(body, default=str)
    }


# ==========================================
# SNS NOTIFICATION
# ==========================================

def send_new_complaint_notification(item):

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

Please log in to the CampusConnect dashboard.
"""

    try:
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject="New CampusConnect Complaint",
            Message=message
        )
        print("SNS notification published successfully")

    except ClientError as error:
        print("SNS notification failed:", error)

    except Exception as error:
        print("Unexpected SNS error:", str(error))


# ==========================================
# USER REGISTRATION
# ==========================================

def register_user(body):

    if not isinstance(body, dict):
        return response(400, {
            "error": "Invalid request body"
        })

    full_name = str(body.get("full_name", "")).strip()
    email = str(body.get("email", "")).strip().lower()
    mobile = str(body.get("mobile", "")).strip()
    role = str(body.get("role", "")).strip().lower()

    if not all([full_name, email, mobile, role]):
        return response(400, {
            "error": "Please fill in all required fields"
        })

    if len(full_name) > 120:
        return response(400, {
            "error": "Full name is too long"
        })

    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return response(400, {
            "error": "Invalid email address"
        })

    if not re.fullmatch(r"[0-9+\-\s()]{7,20}", mobile):
        return response(400, {
            "error": "Invalid mobile number"
        })

    if role not in {"student", "analyst", "administrator"}:
        return response(400, {
            "error": "Invalid registration role"
        })

    current_time = datetime.now(timezone.utc).isoformat()

    item = {
        "email": email,
        "full_name": full_name,
        "mobile": mobile,
        "requested_role": role,
        "account_status": "pending_approval",
        "created_at": current_time
    }

    # Student details
    if role == "student":

        roll_number = str(body.get("roll_number", "")).strip()
        course = str(body.get("course", "")).strip()
        semester = str(body.get("semester", "")).strip()
        department = str(body.get("department", "")).strip()

        if not all([
            roll_number,
            course,
            semester,
            department
        ]):
            return response(400, {
                "error": "Complete all student details"
            })

        item.update({
            "roll_number": roll_number[:50],
            "course": course[:100],
            "semester": semester[:30],
            "department": department[:100]
        })

    # Analyst and Administrator details
    else:

        employee_id = str(body.get("employee_id", "")).strip()
        department = str(body.get("department", "")).strip()
        designation = str(body.get("designation", "")).strip()

        if not all([
            employee_id,
            department,
            designation
        ]):
            return response(400, {
                "error": "Complete all employee details"
            })

        item.update({
            "employee_id": employee_id[:50],
            "department": department[:100],
            "designation": designation[:100]
        })

    try:

        users_table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(email)"
        )

        print("User registration saved:", email)

        return response(201, {
            "message": "Registration submitted successfully. Approval and password setup are still required.",
            "email": email,
            "account_status": "pending_approval"
        })

    except ClientError as error:

        error_code = error.response["Error"]["Code"]

        if error_code == "ConditionalCheckFailedException":
            return response(409, {
                "error": "This email is already registered"
            })

        print("User registration failed:", error)

        return response(500, {
            "error": "Could not save registration"
        })


# ==========================================
# LAMBDA HANDLER
# ==========================================

def lambda_handler(event, context):

    method = event.get(
        "requestContext", {}
    ).get("http", {}).get("method", "GET")

    path = event.get("rawPath", "/").rstrip("/") or "/"

    # CORS
    if method == "OPTIONS":
        return response(200, {"ok": True})

    # Health check
    if method == "GET" and path == "/health":
        return response(200, {"status": "ok"})

    # ======================================
    # REGISTER USER
    # ======================================

    if method == "POST" and path == "/register":

        try:
            body = json.loads(event.get("body") or "{}")
            return register_user(body)

        except json.JSONDecodeError:
            return response(400, {
                "error": "Invalid JSON"
            })

        except Exception as error:
            print("Registration API error:", str(error))
            return response(500, {
                "error": "Internal server error"
            })

    # ======================================
    # S3 UPLOAD URL
    # ======================================

    if method == "POST" and path == "/upload-url":

        try:
            body = json.loads(event.get("body") or "{}")

            content_type = body.get("content_type", "")

            allowed_types = {
                "image/jpeg": "jpg",
                "image/png": "png"
            }

            if content_type not in allowed_types:
                return response(400, {
                    "error": "Only JPEG and PNG images are allowed"
                })

            try:
                file_size = int(body.get("file_size", 0))
            except (TypeError, ValueError):
                return response(400, {
                    "error": "Invalid file size"
                })

            if file_size <= 0 or file_size > 5 * 1024 * 1024:
                return response(400, {
                    "error": "Image must be between 1 byte and 5 MB"
                })

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

        except ClientError as error:
            print("S3 upload URL error:", error)
            return response(500, {
                "error": "Could not generate upload URL"
            })

        except json.JSONDecodeError:
            return response(400, {
                "error": "Invalid JSON"
            })

        except Exception as error:
            print("Unexpected S3 error:", str(error))
            return response(500, {
                "error": "Internal server error"
            })

    # ======================================
    # GET COMPLAINTS
    # ======================================

    if method == "GET" and path == "/complaints":

        try:
            result = table.scan(Limit=50)

            return response(200, {
                "items": result.get("Items", [])
            })

        except ClientError as error:
            print("DynamoDB scan failed:", error)
            return response(500, {
                "error": "Could not load complaints"
            })

    # ======================================
    # UPDATE COMPLAINT STATUS
    # ======================================

    if method == "POST" and path == "/update-status":

        try:
            body = json.loads(event.get("body") or "{}")

            if not isinstance(body, dict):
                return response(400, {
                    "error": "Request body must be a JSON object"
                })

            complaint_id = str(
                body.get("complaint_id", "")
            ).strip()

            new_status = str(
                body.get("status", "")
            ).strip().lower()

            admin_remarks = str(
                body.get("admin_remarks", "")
            ).strip()[:1000]

            allowed_statuses = {
                "pending",
                "in_progress",
                "completed",
                "rejected"
            }

            if not complaint_id:
                return response(400, {
                    "error": "Complaint ID is required"
                })

            if new_status not in allowed_statuses:
                return response(400, {
                    "error": "Invalid complaint status"
                })

            current_time = datetime.now(timezone.utc).isoformat()

            history_entry = {
                "status": new_status,
                "remarks": admin_remarks,
                "changed_at": current_time
            }

            update_expression = """
                SET #status = :status,
                    updated_at = :updated_at,
                    admin_remarks = :remarks,
                    status_history = list_append(
                        if_not_exists(status_history, :empty_list),
                        :history
                    )
            """

            expression_values = {
                ":status": new_status,
                ":updated_at": current_time,
                ":remarks": admin_remarks,
                ":empty_list": [],
                ":history": [history_entry]
            }

            if new_status == "completed":
                update_expression += ", resolved_at = :resolved_at"
                expression_values[":resolved_at"] = current_time
            else:
                update_expression += " REMOVE resolved_at"

            result = table.update_item(
                Key={
                    "complaint_id": complaint_id
                },
                UpdateExpression=update_expression,
                ExpressionAttributeNames={
                    "#status": "status"
                },
                ExpressionAttributeValues=expression_values,
                ConditionExpression="attribute_exists(complaint_id)",
                ReturnValues="ALL_NEW"
            )

            print("Complaint status updated:", complaint_id)

            return response(200, {
                "message": "Complaint status updated successfully",
                "item": result.get("Attributes", {})
            })

        except json.JSONDecodeError:
            return response(400, {
                "error": "Invalid JSON"
            })

        except ClientError as error:

            error_code = error.response["Error"]["Code"]
            print("Complaint status update failed:", error)

            if error_code == "ConditionalCheckFailedException":
                return response(404, {
                    "error": "Complaint not found"
                })

            return response(500, {
                "error": "Could not update complaint status"
            })

        except Exception as error:
            print("Unexpected status update error:", str(error))
            return response(500, {
                "error": "Internal server error"
            })

    # ======================================
    # REGISTER COMPLAINT
    # ======================================

    if method == "POST" and path == "/complaints":

        try:
            body = json.loads(event.get("body") or "{}")

            if not isinstance(body, dict):
                return response(400, {
                    "error": "Request body must be a JSON object"
                })

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
                return response(400, {
                    "error": "Missing required fields"
                })

            priority = str(
                body.get("priority", "medium")
            ).lower()

            if priority not in {"low", "medium", "high"}:
                return response(400, {
                    "error": "Priority must be low, medium, or high"
                })

            # Validate attachment
            attachment_key = str(
                body.get("attachment_key", "")
            ).strip()

            if attachment_key:

                if not re.fullmatch(
                    r"attachments/[0-9a-fA-F-]{36}\.(jpg|png)",
                    attachment_key
                ):
                    return response(400, {
                        "error": "Invalid attachment key"
                    })

                try:
                    uploaded_file = s3.head_object(
                        Bucket=S3_BUCKET,
                        Key=attachment_key
                    )

                    if uploaded_file.get("ContentLength", 0) > 5 * 1024 * 1024:
                        return response(400, {
                            "error": "Image exceeds 5 MB"
                        })

                    if uploaded_file.get("ContentType") not in {
                        "image/jpeg",
                        "image/png"
                    }:
                        return response(400, {
                            "error": "Invalid image type"
                        })

                except ClientError:
                    return response(400, {
                        "error": "Uploaded image not found"
                    })

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
                "attachment_key": attachment_key,
                "status_history": [
                    {
                        "status": "submitted",
                        "remarks": "Complaint registered",
                        "changed_at": current_time
                    }
                ]
            }

            table.put_item(Item=item)

            print("Complaint saved successfully:", item["complaint_id"])

            # SNS remains disabled for complaint submission
            print("SNS notification temporarily disabled")

            return response(201, {
                "item": item
            })

        except json.JSONDecodeError:
            return response(400, {
                "error": "Invalid JSON"
            })

        except ClientError as error:
            print("DynamoDB or S3 operation failed:", error)
            return response(500, {
                "error": "Could not save complaint"
            })

        except Exception as error:
            print("Unexpected complaint error:", str(error))
            return response(500, {
                "error": "Internal server error"
            })

    # ======================================
    # UNKNOWN ROUTE
    # ======================================

    return response(404, {
        "error": "Not found"
    })