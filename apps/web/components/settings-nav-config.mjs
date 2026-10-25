export const settingsGroups = [
  {
    heading: "Preferences",
    items: [
      { id: "general", label: "General", href: "/settings", exact: true, icon: "general" },
      { id: "updates", label: "Updates", href: "/settings/updates", icon: "updates" },
      { id: "notification-inbox", label: "Notifications", href: "/settings/notifications", icon: "notifications" },
      { id: "usage", label: "Usage", href: "/settings/usage", icon: "usage" },
    ],
  },
  {
    heading: "Account",
    items: [
      { id: "account", label: "Profile / Account", href: "/settings/account", icon: "account" },
      { id: "security", label: "Security", href: "/settings/security", icon: "shield" },
      { id: "sessions", label: "Sessions & devices", href: "/settings/sessions", icon: "computer" },
      { id: "delete-account", label: "Delete account", href: "/settings/delete", icon: "delete" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "approval-rules", label: "Approval rules", href: "/settings/approval-rules", testId: "nav-approval-rules", icon: "shield" },
      { id: "policy", label: "Policy", href: "/settings/policy", testId: "nav-policy", icon: "shield" },
      { id: "computer", label: "Computer", href: "/settings/computer", icon: "computer" },
      { id: "plugins", label: "Plugins", href: "/settings/plugins", icon: "plugins" },
      { id: "skills", label: "Skills", href: "/settings/skills", icon: "skills" },
      { id: "video-config", label: "Video config", href: "/settings/video", icon: "video" },
      { id: "vault", label: "Vault", href: "/settings/secrets", icon: "vault" },
    ],
  },
  {
    heading: "Billing",
    items: [
      { id: "billing", label: "Billing & invoices", href: "/settings/billing", icon: "billing" },
      { id: "pricing", label: "Pricing", href: "/pricing", icon: "billing" },
    ],
  },
  {
    heading: "Support",
    items: [
      { id: "help-center", label: "Help center", href: "/settings/help", icon: "help" },
      { id: "contact-support", label: "Contact support", href: "/settings/contact", icon: "contact" },
      { id: "my-tickets", label: "My tickets", href: "/settings/tickets", icon: "tickets" },
      { id: "status", label: "Status", href: "/status", icon: "status" },
      { id: "changelog", label: "Changelog", href: "/changelog", icon: "updates" },
    ],
  },
  {
    heading: "Legal",
    items: [
      { id: "terms", label: "Terms", href: "/legal/terms", icon: "legal" },
      { id: "privacy", label: "Privacy", href: "/legal/privacy", icon: "shield" },
      { id: "acceptable-use", label: "Acceptable use", href: "/legal/acceptable-use", icon: "legal" },
    ],
  },
  {
    heading: "Staff",
    items: [
      { id: "system", label: "System", href: "/system", testId: "nav-system", admin: true, icon: "system" },
      { id: "support-inbox", label: "Support inbox", href: "/settings/support", admin: true, icon: "tickets" },
      { id: "incidents", label: "Status incidents", href: "/settings/incidents", admin: true, icon: "status" },
    ],
  },
];
