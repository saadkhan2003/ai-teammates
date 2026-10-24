# Account and support behavior

- Account deletion is immediate. After the password and typed confirmation are accepted, the user row is deleted and owned records that cascade from it are removed. The operation is written to the append-only audit trail before deletion.
- Email change is a verification stub. Email sending is not configured; an email change is not applied until a future verification flow can send and validate a code.
- Authenticator secrets are encrypted with the existing master-key helper. Recovery codes are returned once and stored as hashes.
- Support tickets and messages are scoped to their owner. Staff can list tickets, reply, and update ticket status.
- Legal pages are placeholders and contain no reviewed legal terms.
- Plan prices and the PKR conversion rate are intentionally unconfigured until reviewed values are supplied in `apps/web/data/pricing.ts`.
