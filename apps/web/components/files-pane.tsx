"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";

export function FilesPane({
  botId,
  onChanged,
}: {
  botId: string;
  onChanged: () => void;
}) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);

  async function upload(file: File) {
    const targetPath = file.name;
    setUploading(true);
    setUploadError(null);
    try {
      const response = await apiFetch(`/api/bots/${botId}/files`, {
        method: "PUT",
        headers: { "x-path": targetPath, "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (response.status === 401) throw new ApiError(401, "Sign in required.");
      if (!response.ok) throw new ApiError(response.status, `Upload failed (${response.status}).`);
      toast.success(`Uploaded ${file.name}.`);
      onChanged();
    } catch (caught) {
      setUploadError(errorMessage(caught, "Could not upload that file."));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      data-testid="file-drop"
      className={cn(
        "mt-3 flex h-9 items-center justify-center rounded-lg border border-dashed border-border text-ui text-muted-foreground",
        over && "bg-accent text-foreground",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void upload(file);
      }}
    >
      <label className="flex h-full w-full cursor-pointer items-center justify-center gap-1.5">
        <Plus className="size-3.5" aria-hidden />
        {uploading ? "Uploading…" : "Add a file"}
        <input
          data-testid="file-upload"
          type="file"
          className="sr-only"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      {uploadError ? <p role="alert" className="sr-only">{uploadError}</p> : null}
    </div>
  );
}
