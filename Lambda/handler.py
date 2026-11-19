import json
import os
import uuid
import re
import hashlib
import secrets
import hmac
import base64
import time

from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError


# ==========================================
# AWS CONFIGURATION
# ==========================================

TABLE_NAME = os.environ["TABLE_NAME"]
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]
S3_BUCKET = os.environ["S3_BUCKET"]
AUTH_SECRET = os.environ["AUTH_SECRET"]

# Administrator credentials
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip().lower()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

# Multiple analyst accounts
ANALYST_ACCOUNTS = json.loads(
    os.environ.get("ANALYST_ACCOUNTS", "[]")
)

ANALYST_ACCOUNTS = {
    account["email"].strip().lower(): {
        "password": account["password"],
        "name": account.get("name", "Analyst")
    }
    for account in ANALYST_ACCOUNTS
}

dynamodb = boto3.resource("dynamodb")

table = dynamodb.Table(TABLE_NAME)
users_table = dynamodb.Table("CampusUsersData")

s3 = boto3.client("s3")


# ==========================================
# COMMON RESPONSE
# ==========================================

def response(status_code, body):

    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS"
        },
        "body": json.dumps(body, default=str)
    }


def get_request_body(event):

    body = event.get("body") or "{}"

    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")

    return json.loads(body)


# ==========================================
# PASSWORD SECURITY
# ==========================================

def hash_password(password):

    salt = secrets.token_bytes(16)

    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        600000
    )

    return (
        "pbkdf2_sha256$600000$"
        + salt.hex()
        + "$"
        + password_hash.hex()
    )


def verify_password(password, stored_hash):

    try:

        algorithm, iterations, salt_hex, hash_hex = stored_hash.split("$")

        if algorithm != "pbkdf2_sha256":
            return False

        iterations = int(iterations)

        if iterations != 600000:
            return False

        salt = bytes.fromhex(salt_hex)
        expected_hash = bytes.fromhex(hash_hex)

        actual_hash = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            iterations
        )

        return hmac.compare_digest(
            actual_hash,
            expected_hash
        )

    except (ValueError, TypeError, AttributeError):
        return False


# ==========================================
# LOGIN TOKEN GENERATION
# ==========================================

def generate_login_token(email, role):

    current_time = int(time.time())

    payload = {
        "sub": email,
        "role": role,
        "iat": current_time,
        "exp": current_time + 3600
    }

    payload_json = json.dumps(
        payload,
        separators=(",", ":")
    ).encode("utf-8")

    encoded_payload = base64.urlsafe_b64encode(
        payload_json
    ).decode("utf-8").rstrip("=")

    signature = hmac.new(
        AUTH_SECRET.encode("utf-8"),
        encoded_payload.encode("utf-8"),
        hashlib.sha256
    ).digest()

    encoded_signature = base64.urlsafe_b64encode(
        signature
    ).decode("utf-8").rstrip("=")

    return encoded_payload + "." + encoded_signature


# ==========================================
# TOKEN VERIFICATION
# ==========================================

def authenticate_user(event):

    headers = event.get("headers") or {}

    authorization = (
        headers.get("authorization")
        or headers.get("Authorization")
        or ""
    )

    if not authorization.startswith("Bearer "):
        return None, response(401, {
            "error": "Authentication required. Please log in."
        })

    token = authorization[7:].strip()

    try:
        parts = token.split(".")

        if len(parts) != 2:
            raise ValueError("Invalid token format")

        encoded_payload, encoded_signature = parts

        expected_signature = hmac.new(
            AUTH_SECRET.encode("utf-8"),
            encoded_payload.encode("utf-8"),
            hashlib.sha256
        ).digest()

        supplied_signature = base64.urlsafe_b64decode(
            encoded_signature
            + "=" * (-len(encoded_signature) % 4)
        )

        if not hmac.compare_digest(
            expected_signature,
            supplied_signature
        ):
            raise ValueError("Invalid signature")

        decoded_payload = base64.urlsafe_b64decode(
            encoded_payload
            + "=" * (-len(encoded_payload) % 4)
        )

        payload = json.loads(decoded_payload.decode("utf-8"))

        email = str(payload.get("sub", "")).strip().lower()
        role = str(payload.get("role", "")).strip().lower()
        expiry = int(payload.get("exp", 0))

        if not email or not role:
            raise ValueError("Missing token information")

        if int(time.time()) >= expiry:
            return None, response(401, {
                "error": "Your session has expired. Please log in again."
            })

        if role not in {"student", "administrator", "analyst"}:
            raise ValueError("Invalid role")

    except Exception:
        return None, response(401, {
            "error": "Invalid authentication token. Please log in again."
        })

    # ==========================================
    # ADMINISTRATOR AUTHENTICATION
    # ==========================================
    if role == "administrator":

        if not ADMIN_EMAIL or email != ADMIN_EMAIL:
            return None, response(401, {
                "error": "Administrator account is not authorized"
            })

        return {
            "email": email,
            "role": "administrator",
            "full_name": "Administrator"
        }, None

    # ==========================================
    # ANALYST AUTHENTICATION
    # ==========================================
    if role == "analyst":

        if email not in ANALYST_ACCOUNTS:
            return None, response(401, {
                "error": "Analyst account is not authorized"
            })

        return {
            "email": email,
            "role": "analyst",
            "full_name": ANALYST_ACCOUNTS[email]["name"]
        }, None

    # ==========================================
    # STUDENT AUTHENTICATION
    # ==========================================
    try:

        result = users_table.get_item(
            Key={"email": email}
        )

        user = result.get("Item")

        if not user:
            return None, response(401, {
                "error": "User account not found"
            })

        if user.get("account_status") != "active":
            return None, response(403, {
                "error": "Your account is not active"
            })

        current_role = str(
            user.get("requested_role", "")
        ).lower()

        if current_role != "student":
            return None, response(401, {
                "error": "Account role has changed. Please log in again."
            })

        return {
            "email": email,
            "role": "student",
            "full_name": user.get("full_name", "")
        }, None

    except ClientError as error:

        print("Authentication DynamoDB error:", error)

        return None, response(500, {
            "error": "Unable to verify your account"
        })

    except Exception as error:

        print("Authentication error:", str(error))

        return None, response(500, {
            "error": "Unable to verify your account"
        })


# ==========================================
# ROLE PERMISSIONS
# ==========================================

def require_role(user, allowed_roles):

    if user.get("role") not in allowed_roles:

        return response(403, {
            "error": "You do not have permission to perform this action"
        })

    return None


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

    password = body.get("password", "")

    if not all([full_name, email, mobile, role, password]):
        return response(400, {
            "error": "Please fill in all required fields"
        })

    # Only student registration is allowed
    if role != "student":
        return response(403, {
            "error": "Only students can register through this website"
        })

    if not isinstance(password, str):
        return response(400, {
            "error": "Invalid password"
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

    if len(password) < 8 or len(password) > 128:
        return response(400, {
            "error": "Password must contain 8 to 128 characters"
        })

    if not (
        re.search(r"[A-Z]", password)
        and re.search(r"[a-z]", password)
        and re.search(r"[0-9]", password)
    ):
        return response(400, {
            "error": "Password must contain uppercase, lowercase and numeric characters"
        })

    # Prevent registration using fixed admin or analyst emails
    if email == ADMIN_EMAIL or email in ANALYST_ACCOUNTS:
        return response(409, {
            "error": "This email is reserved for an authorized account"
        })

    password_hash = hash_password(password)

    current_time = datetime.now(timezone.utc).isoformat()

    item = {
        "email": email,
        "full_name": full_name,
        "mobile": mobile,
        "requested_role": "student",
        "account_status": "active",
        "password_hash": password_hash,
        "created_at": current_time
    }

    # Student details
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

    try:

        users_table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(email)"
        )

        return response(201, {
            "message": (
                "Student registration successful. "
                "Your account is active. You can now log in."
            ),
            "email": email,
            "role": "student",
            "account_status": "active"
        })

    except ClientError as error:

        error_code = error.response["Error"]["Code"]

        if error_code == "ConditionalCheckFailedException":
            return response(409, {
                "error": "This email is already registered"
            })

        print("Registration error:", error)

        return response(500, {
            "error": "Could not save registration"
        })


# ==========================================
# USER LOGIN
# ==========================================

def login_user(body):
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    selected_role = str(body.get("role", "")).strip().lower()

    if not email or not password or not selected_role:
         return response(400, {
        "message": "Email, password and role are required"
    })

    if selected_role not in ["student", "analyst", "administrator"]:
          return response(400, {
        "message": "Invalid role selected"
    })

    # ==========================================
    # ADMINISTRATOR LOGIN
    # ==========================================
    if email == ADMIN_EMAIL and ADMIN_EMAIL:
        if not hmac.compare_digest(password, ADMIN_PASSWORD):
            return response(401, {
                "message": "Invalid email or password"
            })

        role = "administrator"
        full_name = "Administrator"

    # ==========================================
    # ANALYST LOGIN
    # ==========================================
    elif email in ANALYST_ACCOUNTS:
        analyst = ANALYST_ACCOUNTS[email]

        if not hmac.compare_digest(password, analyst["password"]):
            return response(401, {
                "message": "Invalid email or password"
            })

        role = "analyst"
        full_name = analyst["name"]

    # ==========================================
    # STUDENT LOGIN
    # ==========================================
    else:
        try:
            result = users_table.get_item(
                Key={"email": email}
            )
            user = result.get("Item")

            if not user or not verify_password(
                password, user.get("password_hash", "")
            ):
                return response(401, {
                    "message": "Invalid email or password"
                })

            if user.get("account_status") != "active":
                return response(403, {
                    "message": "Your account is not active"
                })

            if user.get("requested_role") != "student":
                return response(403, {
                    "message": "This account is not authorized"
                })

            role = "student"
            full_name = user.get("full_name", "Student")

        except ClientError:
            return response(500, {
                "message": "Unable to access user account"
            })
    # ==========================================
    # VERIFY SELECTED RULE
    # ==========================================
    if selected_role != role:
        return response(403, {
            "message": "The selected role does not match your account"
        })
    # ==========================================
    # GENERATE LOGIN TOKEN
    # ==========================================
    token = generate_login_token(email, role)

    return response(200, {
        "message": "Login successful",
        "token": token,
        "user": {
            "email": email,
            "full_name": full_name,
            "role": role
        }
    })

# ==========================================
# GET COMPLAINTS
# ==========================================

def get_complaints(user):

    try:

        if user["role"] in {"administrator", "analyst"}:

            # Administrators and analysts can view all complaints.
            result = table.scan(Limit=100)

        elif user["role"] == "student":

            # Students can view only their own complaints.
            result = table.scan(
                FilterExpression=Attr("student_id").eq(user["email"]),
                Limit=100
            )

        else:

            return response(403, {
                "error": "You are not authorized to access complaints"
            })

        items = result.get("Items", [])

        # Continue scanning if DynamoDB has more records.
        while "LastEvaluatedKey" in result and len(items) < 100:

            result = table.scan(
                ExclusiveStartKey=result["LastEvaluatedKey"],
                **(
                    {"FilterExpression": Attr("student_id").eq(user["email"])}
                    if user["role"] == "student"
                    else {}
                ),
                Limit=100
            )

            items.extend(result.get("Items", []))

        return response(200, {
            "items": items[:100]
        })

    except ClientError as error:

        print("DynamoDB complaint scan failed:", error)

        return response(500, {
            "error": "Could not load complaints"
        })

# ==========================================
# GENERATE S3 UPLOAD URL
# ==========================================

def generate_upload_url(body):

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

    try:

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


# ==========================================
# REGISTER NEW COMPLAINT
# ==========================================

def create_complaint(body, user):

    if not isinstance(body, dict):
        return response(400, {
            "error": "Request body must be a JSON object"
        })

    required = [
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

        except ClientError as error:

            print("Attachment validation error:", error)

            return response(400, {
                "error": "Uploaded image not found or invalid"
            })

    current_time = datetime.now(timezone.utc).isoformat()

    # Retrieve the student's registered department
    try:
        student_result = users_table.get_item(
            Key={"email": user["email"]}
        )

        student_data = student_result.get("Item", {})

        department = student_data.get(
            "department",
            "Not specified"
        )

    except ClientError as error:
        print("Student department lookup error:", error)

        return response(500, {
            "error": "Could not retrieve student details"
        })

    item = {
        "complaint_id": str(uuid.uuid4()),

        # Student identity comes from the verified login token.
        # Never trust a student_id supplied by the browser.
        "student_id": user["email"],
        "department": department,

        "title": str(body["title"]).strip()[:160],
        "category": str(body["category"]).strip()[:80],
        "location": str(body["location"]).strip()[:160],
        "description": str(body["description"]).strip()[:3000],

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

    try:

        table.put_item(Item=item)

        print(
            "Complaint saved successfully:",
            item["complaint_id"]
        )

        # SNS notifications remain disabled.
        print("SNS notification temporarily disabled")

        return response(201, {
            "message": "Complaint registered successfully",
            "item": item
        })

    except ClientError as error:

        print("DynamoDB complaint save error:", error)

        return response(500, {
            "error": "Could not save complaint"
        })


# ==========================================
# UPDATE COMPLAINT STATUS
# ==========================================

def update_complaint_status(body):

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

    try:

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


# ==========================================
# MAIN LAMBDA HANDLER
# ==========================================

def lambda_handler(event, context):

    method = (
        event.get("requestContext", {})
        .get("http", {})
        .get("method", "GET")
    )

    path = event.get("rawPath", "/").rstrip("/") or "/"

    # --------------------------------------
    # CORS PREFLIGHT
    # --------------------------------------

    if method == "OPTIONS":
        return response(200, {
            "message": "CORS preflight successful"
        })

    # --------------------------------------
    # HEALTH CHECK
    # --------------------------------------

    if method == "GET" and path == "/health":
        return response(200, {
            "status": "ok"
        })

    # --------------------------------------
    # LOGIN
    # --------------------------------------

    if method == "POST" and path == "/login":
        try:
            body = get_request_body(event)
            return login_user(body)

        except json.JSONDecodeError:
            return response(400, {
                "error": "Invalid JSON"
            })

        except Exception as error:
            print("Login API error:", str(error))
            return response(500, {
                "error": "Internal server error"
            })

    # --------------------------------------
    # REGISTRATION
    # --------------------------------------

    if method == "POST" and path == "/register":
        try:
            body = get_request_body(event)
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

    # --------------------------------------
    # AUTHENTICATION FOR PROTECTED ROUTES
    # --------------------------------------

    protected_routes = {
        ("GET", "/complaints"),
        ("POST", "/complaints"),
        ("POST", "/upload-url"),
        ("POST", "/update-status")
    }

    if (method, path) in protected_routes:

        user, auth_error = authenticate_user(event)

        if auth_error:
            return auth_error

        # ----------------------------------
        # STUDENT, ADMIN AND ANALYST:
        # VIEW COMPLAINTS
        # ----------------------------------

        if method == "GET" and path == "/complaints":

            permission_error = require_role(
                user,
                {"student", "administrator", "analyst"}
            )

            if permission_error:
                return permission_error

            return get_complaints(user)

        # ----------------------------------
        # STUDENT ONLY: CREATE COMPLAINT
        # ----------------------------------

        if method == "POST" and path == "/complaints":

            permission_error = require_role(
                user,
                {"student"}
            )

            if permission_error:
                return permission_error

            try:
                body = get_request_body(event)
                return create_complaint(body, user)

            except json.JSONDecodeError:
                return response(400, {
                    "error": "Invalid JSON"
                })

            except Exception as error:
                print("Complaint creation error:", str(error))
                return response(500, {
                    "error": "Internal server error"
                })

        # ----------------------------------
        # STUDENT ONLY: S3 ATTACHMENT UPLOAD
        # ----------------------------------

        if method == "POST" and path == "/upload-url":

            permission_error = require_role(
                user,
                {"student"}
            )

            if permission_error:
                return permission_error

            try:
                body = get_request_body(event)

                if not isinstance(body, dict):
                    return response(400, {
                        "error": "Invalid request body"
                    })

                return generate_upload_url(body)

            except json.JSONDecodeError:
                return response(400, {
                    "error": "Invalid JSON"
                })

            except Exception as error:
                print("Upload URL error:", str(error))
                return response(500, {
                    "error": "Internal server error"
                })

        # ----------------------------------
        # ADMIN ONLY: UPDATE COMPLAINT
        # ----------------------------------

        if method == "POST" and path == "/update-status":

            permission_error = require_role(
                user,
                {"administrator", "analyst"}
            )

            if permission_error:
                return permission_error

            try:
                body = get_request_body(event)
                return update_complaint_status(body)

            except json.JSONDecodeError:
                return response(400, {
                    "error": "Invalid JSON"
                })

            except Exception as error:
                print("Status update error:", str(error))
                return response(500, {
                    "error": "Internal server error"
                })

    # --------------------------------------
    # UNKNOWN ROUTE
    # --------------------------------------

    return response(404, {
        "error": "Not found"
    })