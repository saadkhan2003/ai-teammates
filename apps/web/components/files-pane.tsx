"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiFetch } from "@/lib/api";
import type { FileEntry } from "@/lib/types";
import { errorMessage, formatBytes } from "@/lib/utils";

export function FilesPane({
  botId,
  files,
  error,
  loaded,
  onChanged,
}: {
  botId: string;
  files: FileEntry[];
  error: string | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [path, setPath] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File, targetPath: string) {
    setUploading(true);
    setUploadError(null);
    try {
      const response = await apiFetch(`/api/bots/${botId}/files`, {
        method: "PUT",
        headers: { "x-path": targetPath, "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (response.status === 401) throw new ApiError(401, "Sign in required.");
      if (!response.ok) {
        throw new ApiError(response.status, `Upload failed (${response.status}).`);
      }
      toast.success(`Uploaded ${targetPath}.`);
      onChanged();
    } catch (caught) {
      setUploadError(errorMessage(caught, "Could not upload that file."));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2">
      <form
        className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="file-path">Workspace path</Label>
          <Input
            id="file-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="notes.txt"
          />
          <p className="text-xs text-muted-foreground">The file is sent as the raw body with this path in the x-path header.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="file-upload">File</Label>
          <Input
            id="file-upload"
            data-testid="file-upload"
            type="file"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const target = path.trim() || file.name;
              setPath(target);
              void upload(file, target);
            }}
          />
        </div>
        {uploading ? <p className="text-sm text-muted-foreground">Uploading…</p> : null}
        {uploadError ? (
          <p role="alert" className="text-sm text-clay">
            {uploadError}
          </p>
        ) : null}
      </form>
      <div data-testid="file-list" className="rounded-lg border border-line bg-paper p-4">
        {!loaded ? <p className="text-sm text-muted-foreground">Loading files…</p> : null}
        {loaded && error ? (
          <p role="alert" className="text-sm text-clay">
            Could not load files. {error}
          </p>
        ) : null}
        {loaded && !error && files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files in this workspace yet. Upload one the bot can read.</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0">
              <div>
                <p className="text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {file.path}
                  {file.size != null ? ` · ${formatBytes(file.size)}` : ""}
                  {file.directory ? " · folder" : ""}
                </p>
              </div>
              {file.directory ? null : (
                <a className="text-sm font-medium text-copper-deep underline" href={`/api/bots/${botId}/files/raw?path=${encodeURIComponent(file.path)}`}>
                  Download
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
