"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function UpdatesPage() {
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">Updates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-0 text-sm text-muted-foreground">
        <p>This install is Teammates 0.2.</p>
        <p>Self-hosted copies do not check a vendor for updates. Pull a new image when you want the next build.</p>
      </CardContent>
    </Card>
  );
}
