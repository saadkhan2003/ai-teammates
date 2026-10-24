export const settingsGroups = [
  {
    heading: "Account",
    items: [
      { id: "profile", label: "Profile / Account", href: "/settings/account" },
      { id: "security", label: "Security", href: "/settings/security" },
      { id: "sessions", label: "Sessions", href: "/settings/sessions" },
      { id: "delete-account", label: "Delete account", href: "/settings/delete-account" },
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
      { id: "video-config", label: "Video config", href: "/settings/video" },
      { id: "skills", label: "Skills", href: "/settings/skills" },
    ],
  },
  {
    heading: "Billing",
    items: [{ id: "billing", label: "Usage & Billing", href: "/settings/usage" }],
  },
  {
    heading: "Support",
    items: [
      { id: "help-center", label: "Help center", href: "/settings/help" },
      { id: "contact-support", label: "Contact support", href: "/settings/contact-support" },
      { id: "my-tickets", label: "My tickets", href: "/settings/tickets" },
    ],
  },
  {
    heading: "System",
    items: [
      { id: "updates", label: "Updates", href: "/settings/updates" },
      { id: "system", label: "System", href: "/system", testId: "nav-system", admin: true },
    ],
  },
];
