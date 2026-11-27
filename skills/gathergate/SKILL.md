---
name: gathergate
description: Operate a self-hosted GatherGate client document collection instance over its metadata-only MCP endpoint. Use to list checklist templates, create new AU/UK/US/EU intake packs, triage overdue or incomplete client packs, update due dates, and trigger polite follow-up reminders while keeping all sensitive IDs and uploaded files strictly inside GatherGate's browser ReviewSheet.
---

# GatherGate Operator Skill

Use GatherGate's stateless MCP endpoint (`POST /mcp`) to manage client intake checklists without exposing raw personal data or uploaded files to an LLM context window.

## Hard Security Boundary

1. **Metadata-only by design**: GatherGate's MCP tools never return decrypted Tax File Numbers (TFNs), Medicare numbers, UK NINOs, US SSNs, client notes, uploaded file names, file bytes, download links, or raw magic-link tokens.
2. **Direct humans to `review_url`**: Whenever a client has submitted items for review or an operator needs to inspect an uploaded document or reveal a masked national ID, return the `review_url` from `get_request_status` or `list_requests` so the operator reviews it inside GatherGate's sandboxed browser `ReviewSheet`.
3. **Least-privilege API keys**:
   - Read-only triage uses a workspace API key with `mcp:read`.
   - Creating requests, updating due dates, or sending reminders also requires `requests:write`.
   - Never ask the user to paste an API key into chat if it is already configured in MCP client headers.

## Core Workflows

### 1. Create a Client Intake Pack from a Template
1. Call `list_templates` to inspect available workspace templates (built-in AU Tax, AU BAS, AU Allied Health, Agency Onboarding, Legal/KYC, Mortgage/Loan, or custom packs).
2. Confirm the client's name, email address, pack title, and optional due date with the operator if any field is missing.
3. Call `create_request` with `template_id`, `title`, `client_name`, `client_email`, optional `due_at` (ISO 8601), `require_otp` (recommend `true` for packs containing TFN, Medicare, NINO, SSN, or identity documents), and `send_invite: true`.
4. Report the created `request_id`, item count, invite status, and operator `review_url`.

### 2. Triage Overdue or Incomplete Packs
1. Call `list_overdue_requests` (optionally passing `within_days` to include packs due soon) or `list_requests` filtered by `status: "open"` or `status: "in_review"`.
2. For any pack needing detail, call `get_request_status` with `request_id` to see per-item progress (`pending`, `submitted`, `rejected`, `approved`), required flags, and validator types.
3. Group results clearly for the operator:
   - **Awaiting operator review** (`submitted` items): link directly to `review_url`.
   - **Waiting on client** (`pending` or `rejected` items): list missing item labels and offer to send a reminder or extend the due date.

### 3. Follow Up Politely or Adjust Deadlines
- Before calling `send_reminder`, check `reminders_sent`, `max_reminders`, and whether the pack has outstanding (`pending` or `rejected`) items. Note that GatherGate enforces a 15-minute cooldown between manual reminders.
- Use `update_due_date` with an ISO 8601 timestamp (or `null` to clear) when the operator grants a client extension.

## Supporting References

Read these MCP resources only when needed:
- `skill://gathergate/references/intake-workflows.md` (regional validator packs and template guidance)
- `skill://gathergate/references/security-boundary.md` (scopes, audit trail, and zero-PII guarantees)
