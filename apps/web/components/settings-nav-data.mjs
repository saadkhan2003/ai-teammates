/** Shared settings navigation contract. Keep ids, labels, and destinations unique. */
export const settingsNavGroups = [
  {
    heading: "Account",
    items: [
      { id: "account", label: "Profile / Account", href: "/settings/account" },
      { id: "security", label: "Security", href: "/settings/security" },
      { id: "sessions", label: "Sessions", href: "/settings/sessions" },
      { id: "delete-account", label: "Delete account", href: "/settings/delete" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "general", label: "General", href: "/settings", exact: true },
      { id: "policy", label: "Policy", href: "/settings/policy", testId: "nav-policy" },
      { id: "approval-rules", label: "Approval rules", href: "/settings/approval-rules", testId: "nav-approval-rules" },
      { id: "computer", label: "Computer", href: "/settings/computer" },
      { id: "vault", label: "Vault", href: "/settings/secrets" },
      { id: "plugins", label: "Plugins", href: "/settings/plugins" },
      { id: "video-config", label: "Video config", section: "video-config" },
    ],
  },
  {
    heading: "Billing",
    items: [{ id: "billing", label: "Billing", href: "/settings/billing" }],
  },
  {
    heading: "Support",
    items: [
      { id: "help-center", label: "Help center", href: "/settings/help" },
      { id: "contact-support", label: "Contact support", href: "/settings/contact" },
      { id: "my-tickets", label: "My tickets", href: "/settings/tickets" },
    ],
  },
  {
    heading: "System",
    items: [
      { id: "updates", label: "Updates", href: "/settings/updates" },
      { id: "system", label: "System", href: "/system", admin: true, testId: "nav-system" },
      { id: "support-inbox", label: "Support inbox", href: "/settings/support", admin: true },
    ],
  },
];
