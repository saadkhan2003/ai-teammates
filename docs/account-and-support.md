# Account and support behavior

- Account deletion is immediate. The last active owner cannot delete their account. After the password and typed confirmation are accepted, the user row is deleted and owned records that cascade from it are removed. The operation is written to the append-only audit trail before deletion.
- Email change is a verification stub. Email sending is not configured; an email change is not applied until a future verification flow can send and validate a code.
- Revoking a session or deleting an account invalidates the session cache and notifies other API instances.
- Authenticator secrets are encrypted with the existing master-key helper. Recovery codes are returned once and stored as hashes.
- Support tickets and messages are scoped to their owner. Owners and admins can list tickets, reply, and update ticket status.
- Legal pages are placeholders and contain no reviewed legal terms.
- Plan prices and the PKR conversion rate are configured by an owner or admin in Settings → Billing. The editor saves to `/api/admin/billing/config`; the public pricing page reads `/api/pricing`. Existing plan balances and invoices remain available.
