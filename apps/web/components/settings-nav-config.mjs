export const settingsGroups = [
  {
    heading: "Preferences",
    items: [
      { id: "general", label: "General", href: "/settings", exact: true, icon: "general" },
      { id: "updates", label: "Updates", href: "/settings/updates", icon: "updates" },
      { id: "notifications", label: "Notifications", href: "/settings/notifications", icon: "notifications" },
      { id: "usage", label: "Usage", href: "/settings/usage", icon: "usage" },
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
      { id: "vault", label: "Vault", href: "/settings/secrets", icon: "vault" },
    ],
  },
  {
    heading: "Staff",
    items: [{ id: "system", label: "System", href: "/system", testId: "nav-system", admin: true, icon: "system" }],
  },
];
