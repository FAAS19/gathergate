# GatherGate MCP Security Boundary

GatherGate is designed so AI assistants can coordinate client document intake without becoming a data processor for sensitive client records.

## What MCP Never Exposes

- Decrypted or masked national identifiers (`TFN`, `Medicare`, `NINO`, `SSN`)
- Raw text answers or encrypted client notes
- Uploaded file bytes, original filenames, storage keys, or download/preview URLs
- Raw client magic-link tokens or full client email addresses in list/status responses
- Workspace secrets (SMTP passwords, Resend API keys, webhook signing secrets, or API keys)

## Authentication & Scopes

- `POST /mcp` requires an `Authorization: Bearer gg_live_...` workspace API key minted in **Settings > API Keys**. Browser session cookies are not accepted on `/mcp`.
- Every query and mutation is isolated strictly to the API key's `workspace_id`.
- **Read tools & resources** (`list_templates`, `list_requests`, `get_request_status`, `list_overdue_requests`, `resources/*`, `skills/*`) require `mcp:read`.
- **Write tools** (`create_request`, `send_reminder`, `update_due_date`) require both `mcp:read` and `requests:write`.
- Every MCP mutation writes an `audit_events` entry with `actor: "api_key"` and `via: "mcp"`.
- Revoking the API key in **Settings > API Keys** immediately blocks future MCP calls with HTTP 401.
