const WORKER_URL = "https://YOUR-WORKER.workers.dev";

export async function submitForm({
  name,
  email,
  files,
  onProgress,
  onSuccess,
  onError
}) {

  try {
    const form = new FormData();

    form.append("name", name);
    form.append("email", email);

    for (const file of files) {
      form.append("files", file);
    }

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);

        if (xhr.status >= 200 && xhr.status < 300) {
          onSuccess?.(data);
        } else {
          onError?.(data.error || "Upload failed");
        }
      } catch {
        onError?.("Invalid server response");
      }
    };

    xhr.onerror = () => {
      onError?.("Network error");
    };

    xhr.open("POST", `${WORKER_URL}/submit`);
    xhr.send(form);

  } catch (err) {
    onError?.(err.message);
  }
}
